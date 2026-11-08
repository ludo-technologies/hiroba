// Service worker for the browser build (registered in main.ts, never under
// Tauri). Chrome offers to install a web app — the `beforeinstallprompt` the
// phone layout turns into its own offer — only under a worker with a fetch
// handler, and it skips one that is empty. So page loads pass through here,
// straight to the network: nothing is cached, since the office only works
// online anyway.
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") event.respondWith(fetch(event.request));
});
