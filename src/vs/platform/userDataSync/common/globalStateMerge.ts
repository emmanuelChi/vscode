/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as objects from 'vs/base/common/objects';
import { IStorageValue } from 'vs/platform/userDataSync/common/userDataSync';
import { IStringDictionary } from 'vs/base/common/collections';
import { values } from 'vs/base/common/map';
import { IStorageKey } from 'vs/platform/userDataSync/common/storageKeys';
import { ILogService } from 'vs/platform/log/common/log';

export interface IMergeResult {
	local: { added: IStringDictionary<IStorageValue>, removed: string[], updated: IStringDictionary<IStorageValue> };
	remote: IStringDictionary<IStorageValue> | null;
}

export function merge(localStorage: IStringDictionary<IStorageValue> | null, remoteStorage: IStringDictionary<IStorageValue> | null, baseStorage: IStringDictionary<IStorageValue> | null, storageKeys: ReadonlyArray<IStorageKey>, logService: ILogService): IMergeResult {
	if (!remoteStorage) {
		return { remote: localStorage, local: { added: {}, removed: [], updated: {} } };
	}
	if (!localStorage) {
		return { remote: null, local: { added: remoteStorage, removed: [], updated: {} } };
	}

	const localToRemote = compare(localStorage, remoteStorage);
	if (localToRemote.added.size === 0 && localToRemote.removed.size === 0 && localToRemote.updated.size === 0) {
		// No changes found between local and remote.
		return { remote: null, local: { added: {}, removed: [], updated: {} } };
	}

	const baseToRemote = baseStorage ? compare(baseStorage, remoteStorage) : { added: Object.keys(remoteStorage).reduce((r, k) => { r.add(k); return r; }, new Set<string>()), removed: new Set<string>(), updated: new Set<string>() };
	const baseToLocal = baseStorage ? compare(baseStorage, localStorage) : { added: Object.keys(localStorage).reduce((r, k) => { r.add(k); return r; }, new Set<string>()), removed: new Set<string>(), updated: new Set<string>() };

	const local: { added: IStringDictionary<IStorageValue>, removed: string[], updated: IStringDictionary<IStorageValue> } = { added: {}, removed: [], updated: {} };
	const remote: IStringDictionary<IStorageValue> = objects.deepClone(remoteStorage);

	// Added in remote
	for (const key of values(baseToRemote.added)) {
		const remoteValue = remoteStorage[key];
		const storageKey = storageKeys.filter(storageKey => storageKey.key === key)[0];
		if (!storageKey) {
			logService.info(`GlobalState: Skipped adding ${key} in local storage as it is not registered.`);
			continue;
		}
		if (storageKey.version !== remoteValue.version) {
			logService.info(`GlobalState: Skipped adding ${key} in local storage. Local version '${storageKey.version}' and remote version '${remoteValue.version} are not same.`);
			continue;
		}
		const localValue = localStorage[key];
		if (localValue && localValue.value === remoteValue.value) {
			continue;
		}
		if (baseToLocal.added.has(key)) {
			local.updated[key] = remoteValue;
		} else {
			local.added[key] = remoteValue;
		}
	}

	// Updated in Remote
	for (const key of values(baseToRemote.updated)) {
		const remoteValue = remoteStorage[key];
		const storageKey = storageKeys.filter(storageKey => storageKey.key === key)[0];
		if (!storageKey) {
			logService.info(`GlobalState: Skipped updating ${key} in local storage as is not registered.`);
			continue;
		}
		if (storageKey.version !== remoteValue.version) {
			logService.info(`GlobalState: Skipped updating ${key} in local storage. Local version '${storageKey.version}' and remote version '${remoteValue.version} are not same.`);
			continue;
		}
		const localValue = localStorage[key];
		if (localValue && localValue.value === remoteValue.value) {
			continue;
		}
		local.updated[key] = remoteValue;
	}

	// Removed in remote
	for (const key of values(baseToRemote.removed)) {
		const storageKey = storageKeys.filter(storageKey => storageKey.key === key)[0];
		if (!storageKey) {
			logService.info(`GlobalState: Skipped removing ${key} in local storage. It is not registered to sync.`);
			continue;
		}
		local.removed.push(key);
	}

	// Added in local
	for (const key of values(baseToLocal.added)) {
		if (!baseToRemote.added.has(key)) {
			remote[key] = localStorage[key];
		}
	}

	// Updated in local
	for (const key of values(baseToLocal.updated)) {
		if (baseToRemote.updated.has(key) || baseToRemote.removed.has(key)) {
			continue;
		}
		const remoteValue = remote[key];
		const localValue = localStorage[key];
		if (localValue.version < remoteValue.version) {
			logService.info(`GlobalState: Skipped updating ${key} in remote storage. Local version '${localValue.version}' and remote version '${remoteValue.version} are not same.`);
			continue;
		}
		remote[key] = localValue;
	}

	// Removed in local
	for (const key of values(baseToLocal.removed)) {
		if (baseToRemote.updated.has(key)) {
			continue;
		}

		const storageKey = storageKeys.filter(storageKey => storageKey.key === key)[0];
		// do not remove from remote if storage key is not found
		if (!storageKey) {
			logService.info(`GlobalState: Skipped removing ${key} in remote storage. It is not registered to sync.`);
			continue;
		}

		const remoteValue = remote[key];
		// do not remove from remote if local data version is old
		if (storageKey.version < remoteValue.version) {
			logService.info(`GlobalState: Skipped updating ${key} in remote storage. Local version '${storageKey.version}' and remote version '${remoteValue.version} are not same.`);
			continue;
		}

		delete remote[key];
	}

	return { local, remote: areSame(remote, remoteStorage) ? null : remote };
}

function compare(from: IStringDictionary<any>, to: IStringDictionary<any>): { added: Set<string>, removed: Set<string>, updated: Set<string> } {
	const fromKeys = Object.keys(from);
	const toKeys = Object.keys(to);
	const added = toKeys.filter(key => fromKeys.indexOf(key) === -1).reduce((r, key) => { r.add(key); return r; }, new Set<string>());
	const removed = fromKeys.filter(key => toKeys.indexOf(key) === -1).reduce((r, key) => { r.add(key); return r; }, new Set<string>());
	const updated: Set<string> = new Set<string>();

	for (const key of fromKeys) {
		if (removed.has(key)) {
			continue;
		}
		const value1 = from[key];
		const value2 = to[key];
		if (!objects.equals(value1, value2)) {
			updated.add(key);
		}
	}

	return { added, removed, updated };
}

function areSame(a: IStringDictionary<IStorageValue>, b: IStringDictionary<IStorageValue>): boolean {
	const { added, removed, updated } = compare(a, b);
	return added.size === 0 && removed.size === 0 && updated.size === 0;
}

