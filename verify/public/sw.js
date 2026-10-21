importScripts('/snapshot.js');
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  e.source.postMessage({ type: 'lj-sw', snapshot: self.__ljSnapshot() });
});
