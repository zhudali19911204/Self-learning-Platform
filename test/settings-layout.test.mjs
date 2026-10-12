import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSettingsLayoutStore } from '../desktop/settings-layout.mjs';

test('layout preferences only store booleans, queue rapid changes and survive a new application session', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'learnflow-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createSettingsLayoutStore(directory); await store.initialize();
  assert.equal(store.get(), null);
  const panels = { generator: true, reviewer: false, images: false, speech: false };
  const first = store.save(panels), second = store.save({ ...panels, images: true });
  await Promise.all([first, second]); await store.flush();
  const saved = JSON.parse(await readFile(path.join(directory, 'settings-layout.json'), 'utf8'));
  assert.deepEqual(saved, { version: 1, panels: { ...panels, images: true } });
  const copy = store.get(); copy.generator = false; assert.equal(store.get().generator, true);
  await assert.rejects(store.save({ ...panels, apiKey: 'must-not-be-saved' }), /格式/);
  await assert.rejects(store.save({ ...panels, images: 'yes' }), /格式/);
  await assert.rejects(store.save(null), /格式/);
  assert.ok(!(await readFile(path.join(directory, 'settings-layout.json'), 'utf8')).includes('must-not-be-saved'));
  const restored = createSettingsLayoutStore(directory); await restored.initialize(); assert.deepEqual(restored.get(), saved.panels);
});

test('corrupt layout preferences do not block initialization or overwrite any model settings', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'learnflow-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'settings-layout.json'), 'not json');
  await writeFile(path.join(directory, 'settings.json'), 'untouched configuration');
  const store = createSettingsLayoutStore(directory); await store.initialize(); assert.equal(store.get(), null);
  assert.equal(await readFile(path.join(directory, 'settings-layout.json'), 'utf8'), 'not json');
  await store.save({ generator: true, reviewer: true, images: false, speech: false });
  assert.equal(await readFile(path.join(directory, 'settings.json'), 'utf8'), 'untouched configuration');
});
