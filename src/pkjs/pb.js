/*
 * Minimal protobuf wire-format reader/writer for PebbleKit JS.
 *
 * We can't use the Node `protobufjs` package on the phone, and we only need a
 * handful of fields, so this implements just enough of the wire format:
 *   - varints (wire type 0)
 *   - length-delimited bytes/strings/sub-messages (wire type 2)
 * Other wire types (64-bit, 32-bit) are skipped when reading.
 *
 * Everything is Uint8Array based so it works without Node Buffers.
 */

// ---- UTF-8 ----
function strToUtf8(str) {
  str = (str == null) ? '' : String(str);
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00) {
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function utf8ToStr(bytes) {
  var out = '';
  var i = 0;
  while (i < bytes.length) {
    var c = bytes[i++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c >= 0xc0 && c < 0xe0) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (c >= 0xe0 && c < 0xf0) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      var cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

function asciiToBytes(str) {
  var out = new Uint8Array(str.length);
  for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(arrays) {
  var total = 0, i;
  for (i = 0; i < arrays.length; i++) total += arrays[i].length;
  var out = new Uint8Array(total), off = 0;
  for (i = 0; i < arrays.length; i++) { out.set(arrays[i], off); off += arrays[i].length; }
  return out;
}

// ---- Reader ----
function Reader(bytes) {
  this.b = bytes;
  this.p = 0;
  this.len = bytes.length;
}

Reader.prototype.varint = function () {
  // Use multiplication (not <<) to safely read values beyond 32 bits.
  var result = 0, mul = 1, b;
  do {
    b = this.b[this.p++];
    result += (b & 0x7f) * mul;
    mul *= 128;
  } while (b & 0x80);
  return result;
};

Reader.prototype.bytes = function () {
  var len = this.varint();
  var start = this.p;
  this.p += len;
  return this.b.subarray(start, start + len);
};

Reader.prototype.skip = function (wt) {
  if (wt === 0) this.varint();
  else if (wt === 2) { var l = this.varint(); this.p += l; }
  else if (wt === 1) this.p += 8;
  else if (wt === 5) this.p += 4;
};

/*
 * Iterate the fields of a protobuf message.
 * cb(fieldNumber, value, wireType) is called for:
 *   wireType 0 (varint)            -> value is a Number
 *   wireType 2 (length-delimited)  -> value is a Uint8Array (subarray)
 * Other wire types are skipped.
 */
function eachField(bytes, cb) {
  var r = new Reader(bytes);
  while (r.p < r.len) {
    var tag = r.varint();
    var field = Math.floor(tag / 8);
    var wt = tag & 7;
    if (wt === 2) cb(field, r.bytes(), 2);
    else if (wt === 0) cb(field, r.varint(), 0);
    else r.skip(wt);
  }
}

// ---- Writer ----
function Writer() {
  this.parts = [];
}

Writer.prototype._varint = function (v) {
  var bytes = [];
  do {
    var b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  this.parts.push(new Uint8Array(bytes));
};

Writer.prototype._tag = function (field, wt) {
  this._varint(field * 8 + wt);
};

// Write a string field (wire type 2).
Writer.prototype.string = function (field, str) {
  var b = strToUtf8(str);
  this._tag(field, 2);
  this._varint(b.length);
  this.parts.push(b);
  return this;
};

// Write a nested message field (wire type 2) given its already-encoded bytes.
Writer.prototype.message = function (field, bytes) {
  this._tag(field, 2);
  this._varint(bytes.length);
  this.parts.push(bytes);
  return this;
};

Writer.prototype.varint = function (field, value) {
  this._tag(field, 0);
  this._varint(value);
  return this;
};

Writer.prototype.finish = function () {
  return concatBytes(this.parts);
};

// ---- UUID v4 ----
function uuidv4() {
  var s = '';
  for (var i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) { s += '-'; continue; }
    if (i === 14) { s += '4'; continue; }
    var r = Math.floor(Math.random() * 16);
    if (i === 19) r = (r & 0x3) | 0x8;
    s += r.toString(16);
  }
  return s;
}

module.exports = {
  strToUtf8: strToUtf8,
  utf8ToStr: utf8ToStr,
  asciiToBytes: asciiToBytes,
  concatBytes: concatBytes,
  Reader: Reader,
  eachField: eachField,
  Writer: Writer,
  uuidv4: uuidv4,
};
