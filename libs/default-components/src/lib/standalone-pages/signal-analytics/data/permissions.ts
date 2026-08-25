// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the connected user is allowed to do on this page.
 *
 * The runtime's own permission model, nothing else: `WuiUserService` surfaces the
 * flags the webserver put in the user's settings on connect, and the page maps
 * the two it cares about.
 *
 * - **configure** — create, edit and delete signals: `canEdit`.
 * - **run** — ask the manager to analyse: `canWrite`. This is also the flag the
 *   Event manager itself enforces on the `dpSet` the run performs, so gating the
 *   button on it means the UI never offers an action the server will refuse.
 *
 * Page *visibility* is not decided here: it belongs to the `permission` field of
 * the page's `menuconfig.jsonc` entry, which the shell's route guard applies
 * before this component is ever instantiated.
 *
 * `canEdit` / `canWrite` are loaded asynchronously (the user settings arrive
 * after connect), so consumers subscribe to {@link pagePermissions$} and
 * re-render when it emits rather than reading once. With no user service at all
 * — an isolated dev browser — both flags read `true`, matching the page's
 * offline-tolerant behaviour: the store is in demonstration mode there anyway,
 * so nothing can be written.
 */
import { WuiUserService } from '@wincc-oa/wui-iam-data/user-service.js';
import { type Observable, map, of, startWith } from 'rxjs';
import { container } from 'tsyringe';

/** What the page gates on. */
export interface PagePermissions {
  /** May create, edit and delete signals. */
  configure: boolean;
  /** May trigger an analysis (writes the `command` leaf). */
  run: boolean;
}

const OPEN: PagePermissions = { configure: true, run: true };

/** Resolve the user service, or null when unavailable (isolated dev / no DI). */
function userService(): WuiUserService | null {
  try {
    return container.resolve(WuiUserService);
  } catch {
    return null;
  }
}

function read(service: WuiUserService): PagePermissions {
  return {
    // `canEdit` is optional in the settings payload: absent means "not granted".
    configure: service.canEdit === true,
    run: service.canWrite === true
  };
}

/** Current permissions, re-emitted when the user settings load or change. */
export function pagePermissions$(): Observable<PagePermissions> {
  const service = userService();
  if (!service) return of(OPEN);
  return service.user$.pipe(
    map(() => read(service)),
    startWith(read(service))
  );
}

/**
 * Name of the connected user, or `''` when unknown.
 *
 * Audit field only: it travels with every request the page writes, so the
 * manager's log says who asked. Never a permission check — the flags above and
 * the Event manager do that.
 */
export function currentUserName(): string {
  return userService()?.name ?? '';
}
