import './styles/main.css';
import { Game, type GameTestHook } from './game/Game';
import { showFatalError } from './ui/Menu';

declare global {
  interface Window {
    /** Automated-test hook. Only defined on the dev server and in `npm run build:qa` builds. */
    __cityRacer?: GameTestHook;
  }
}

function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

let game: Game | null = null;
let booting = false;

async function boot(): Promise<void> {
  if (game || booting) return; // never initialise the renderer twice
  booting = true;
  const container = document.getElementById('app');
  const loader = document.getElementById('boot-loader');
  if (!container) throw new Error('Missing #app container.');

  const setLoaderText = (s: string) => {
    const t = loader?.querySelector('.boot-text');
    if (t) t.textContent = s;
  };

  if (!hasWebGL2()) {
    loader?.remove();
    showFatalError(container, 'WebGL 2 is not available', 'This game needs WebGL 2 to render 3D graphics, but your browser or GPU did not provide it.');
    booting = false;
    return;
  }

  try {
    game = await Game.create(container, setLoaderText);
    loader?.remove();
    game.start();
    // Compile-time flag: this whole block is removed from the release build (no URL switch).
    if (__QA_HOOK__) {
      const hook = game.createTestHook();
      if (hook) window.__cityRacer = hook;
    }
  } catch (err) {
    console.error(err);
    loader?.remove();
    game = null;
    const message = err instanceof Error ? err.message : String(err);
    showFatalError(container, 'The game failed to start', message);
  } finally {
    booting = false;
  }
}

void boot();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game?.dispose();
    game = null;
    delete window.__cityRacer;
  });
}
