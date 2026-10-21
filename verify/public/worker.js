importScripts('/snapshot.js');
const snap = self.__ljSnapshot();
fetch('/api/headers', { cache: 'no-store' })
  .then((r) => r.json())
  .then((j) => postMessage({ snapshot: snap, fetchAcceptLanguage: j.acceptLanguage }))
  .catch((e) => postMessage({ snapshot: snap, fetchAcceptLanguage: 'ERR: ' + e.message }));
