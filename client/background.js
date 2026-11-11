/*
 * WatchTimeline – hidden background extension. It answers the Claude skill
 * (lib/bridge.js), also while the panel is closed.
 */
(function () {
  'use strict';
  var bridge = WT.createBridge('background', function (what) {
    WT.send(WT.EVT_CHANGED, { what: what });
  });

  window.WT.bridge = bridge;   // for debugging in the DevTools console

  WT.on(WT.EVT_PING, function () {
    WT.send(WT.EVT_PONG, { from: 'background', running: bridge.isRunning() });
  });

  // Keep the extension alive when the panel is closed.
  try { WT.cs.setPersistent && WT.cs.setPersistent(true); } catch (e) {}
  try {
    var ev = new CSEvent('com.adobe.PhotoshopPersistent', 'APPLICATION');
    ev.extensionId = WT.cs.getExtensionID();
    WT.cs.dispatchEvent(ev);
  } catch (e) {}

  // A reload of this page must not leave the old bridge running.
  window.addEventListener('beforeunload', function () { bridge.stop(); });

  WT.loadHost().then(function () {
    bridge.start();
    WT.send(WT.EVT_PONG, { from: 'background', running: true });
  });
})();
