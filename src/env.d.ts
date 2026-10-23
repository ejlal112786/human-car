/// <reference types="vite/client" />

/**
 * Compile-time flag injected by vite.config.ts (`define`). True only for the dev server and
 * the `qa` build mode; false (and the guarded code stripped) in the release build.
 */
declare const __QA_HOOK__: boolean;
