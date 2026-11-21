import { ScreenPresenter } from '@e2e-dev/core/lib/agent/screen-update';

/**
 * A session screen presenter, with folding on. Both session kinds share it:
 * the standalone session and the session attached to a held test. Each has
 * a whole-tree `observe` to read a folded subtree back, so a persistent
 * sidebar is not repeated on every page transition.
 */
export function createSessionScreenPresenter(): ScreenPresenter {
  return new ScreenPresenter({ foldUnchangedSubtrees: true });
}
