import fs from "node:fs";
import path from "node:path";

// Test-server preload only. A file holds one fake chat or village translation (by its text); its removal
// releases the worker as soon as the file's absence is observed.
const directory = process.env.E2E_SERVER_CLOCK ? path.dirname(process.env.E2E_SERVER_CLOCK) : null;
if (directory) {
  globalThis.__tomolaFakeBeforeTranslate = async request => {
    const name = request.invitationNote ? "fake-invitation-note-hold" : request.chat ? "fake-chat-translation-hold" : request.village ? "fake-village-translation-hold" : request.field === "body" ? "fake-body-translation-hold" : null;
    const file = name ? path.join(directory, name) : null;
    if (!file) return;
    try { if (fs.readFileSync(file, "utf8") !== request.text) return; }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    await new Promise(resolve => {
      const changed = () => {
        if (!fs.existsSync(file)) { clearInterval(timer); resolve(); }
      };
      // Deletion before watchFile's first stat can produce no notification.
      // Check the condition directly, without using an inotify watch.
      const timer = setInterval(changed, 25);
      timer.unref();
      changed();
    });
  };
}
