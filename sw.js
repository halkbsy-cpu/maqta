// يخلي المتصفح يعتبر الصفحة تطبيقاً قابلاً للتثبيت. ما يخزّن شيئاً.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
