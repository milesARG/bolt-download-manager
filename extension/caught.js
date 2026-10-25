'use strict';
// A one-time panel download link was redirected here before the browser could
// use it up. Hand it to the extension, then go back to the panel page.
(async () => {
  let url = location.hash.slice(1);
  if (/^https?%3A/i.test(url)) url = decodeURIComponent(url);
  const r = await chrome.runtime.sendMessage({ cmd: 'caught', url });
  if (r && r.browser) document.getElementById('msg').textContent = 'Bolt isn\'t running, so your browser is downloading it.';
  else if (!r || !r.ok) document.getElementById('msg').textContent = 'This link could not be handled.';
  setTimeout(async () => {
    if (history.length > 1) history.back();
    else {
      const tab = await chrome.tabs.getCurrent();
      if (tab) chrome.tabs.remove(tab.id);
    }
  }, 900);
})();
