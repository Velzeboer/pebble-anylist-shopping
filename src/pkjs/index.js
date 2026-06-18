/*
 * PebbleKit JS — runs on the phone. Standalone: talks to AnyList directly,
 * no proxy server. Credentials come from the Clay settings page.
 */

var Clay = require('pebble-clay');
var clayConfig = require('./config.json');
var clay = new Clay(clayConfig);

var AnyListClient = require('./anylist');

// ---- Protocol command codes (must match main.c) ----
var CMD_LIST_START = 1;
var CMD_ITEM = 2;
var CMD_LIST_END = 3;
var CMD_ERROR = 4;
var CMD_TOGGLE_OK = 5;
var CMD_REFRESH = 10;        // watch -> phone
var CMD_TOGGLE = 11;         // watch -> phone
var CMD_DELETE_CHECKED = 12; // watch -> phone

var MAX_NAME = 40;
var MAX_CAT = 26;

var client = null;
var items = []; // [{ id, name, cat, checked }]
var sendQueue = [];
var sending = false;

function truncate(s, n) {
  s = (s == null) ? '' : s.toString();
  return s.length > n ? s.substring(0, n) : s;
}

function getSettings() {
  try { return JSON.parse(localStorage.getItem('clay-settings')) || {}; }
  catch (e) { return {}; }
}

// ---- AppMessage outbox queue (one at a time) ----
function enqueue(msg) { sendQueue.push(msg); pump(); }

function pump() {
  if (sending || sendQueue.length === 0) return;
  sending = true;
  var msg = sendQueue.shift();
  Pebble.sendAppMessage(msg, function () {
    sending = false; pump();
  }, function () {
    setTimeout(function () {
      Pebble.sendAppMessage(msg, function () { sending = false; pump(); },
        function () { sending = false; pump(); });
    }, 250);
  });
}

function sendError(text) { enqueue({ cmd: CMD_ERROR, msg: truncate(text, 60) }); }

function flattenAndSend(data) {
  items = [];
  var categories = data.categories || [];
  for (var c = 0; c < categories.length; c++) {
    var catName = categories[c].name || 'Other';
    var list = categories[c].items || [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var label = it.name || '';
      if (it.quantity) label += ' (' + it.quantity + ')';
      items.push({ id: it.id, name: truncate(label, MAX_NAME), cat: truncate(catName, MAX_CAT), checked: it.checked ? 1 : 0 });
    }
  }
  enqueue({ cmd: CMD_LIST_START, count: items.length, list: truncate(data.list || 'Shopping', MAX_CAT) });
  for (var k = 0; k < items.length; k++) {
    enqueue({ cmd: CMD_ITEM, idx: k, name: items[k].name, cat: items[k].cat, chk: items[k].checked });
  }
  enqueue({ cmd: CMD_LIST_END });
}

function ensureClient() {
  var s = getSettings();
  if (!s.anylist_email || !s.anylist_password) return null;
  if (!client) client = new AnyListClient(s.anylist_email, s.anylist_password);
  return client;
}

function loadAndSend() {
  var s = getSettings();
  var c = ensureClient();
  if (!c) { sendError('Open app settings to add login'); return; }
  c.getCategorizedList(s.anylist_list || '', true, function (err, data) {
    if (err) { sendError(err); return; }
    flattenAndSend(data);
  });
}

function toggle(idx, checked) {
  if (idx < 0 || idx >= items.length) return;
  var c = ensureClient();
  if (!c) { sendError('Open app settings to add login'); return; }
  var item = items[idx];
  c.checkItem(item.id, checked, function (err) {
    if (err) { sendError(err); return; }
    item.checked = checked ? 1 : 0;
    enqueue({ cmd: CMD_TOGGLE_OK, idx: idx, chk: item.checked });
  });
}

function deleteChecked() {
  var s = getSettings();
  var c = ensureClient();
  if (!c) { sendError('Open app settings to add login'); return; }
  c.removeCheckedItems(s.anylist_list || '', function (err) {
    if (err) { sendError(err); return; }
    loadAndSend(); // refresh the list after removal
  });
}

// ---- Pebble events ----
Pebble.addEventListener('ready', function () {
  loadAndSend();
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p.cmd === CMD_REFRESH) loadAndSend();
  else if (p.cmd === CMD_TOGGLE) toggle(p.idx, p.chk ? true : false);
  else if (p.cmd === CMD_DELETE_CHECKED) deleteChecked();
});

// When settings are saved, drop the cached client and reload.
Pebble.addEventListener('webviewclosed', function (e) {
  if (e && e.response) {
    client = null;
    setTimeout(loadAndSend, 300);
  }
});
