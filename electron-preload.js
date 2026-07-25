// electron-preload.js
// Runs in the renderer process before the page loads.
// Disables beforeunload events so the window close button (X) always works,
// even when the scene has unsaved changes.
const { contextBridge } = require('electron');

// Override window.onbeforeunload and neuter addEventListener for 'beforeunload'
// This must run before the app's JS loads, which preload guarantees.
window.onbeforeunload = null;

// Intercept addEventListener to silently ignore beforeunload registrations
const originalAddEventListener = window.addEventListener.bind(window);
window.addEventListener = function (type, listener, options) {
    if (type === 'beforeunload') {
        // Silently skip beforeunload registrations
        return;
    }
    return originalAddEventListener(type, listener, options);
};

// Also override EventTarget.prototype.addEventListener for document-level handlers
const origETAdd = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'beforeunload') {
        return;
    }
    return origETAdd.call(this, type, listener, options);
};

// Expose a simple API to the renderer (optional, for future use)
contextBridge.exposeInMainWorld('electronApp', {
    platform: process.platform,
    isElectron: true
});
