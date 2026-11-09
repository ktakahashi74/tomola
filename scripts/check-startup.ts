import { safeErrorText } from "../app/lib/error-text.server.ts";
import { assertStartupConfig } from "../app/lib/startup-checks.server";
import { figureTranslationEnabled } from "../app/lib/figure-reading.server";
import { assertFigureFontsAvailable } from "../app/lib/figure-fonts.server";

// The runtime image has generated review counts in app/, but no messages/. Validate configuration and those counts before migrations or server startup.
try {
  assertStartupConfig();
  if (figureTranslationEnabled()) await assertFigureFontsAvailable();
} catch (error) {
  console.error(`[startup] ${safeErrorText(error)}`);
  process.exitCode = 1;
}
