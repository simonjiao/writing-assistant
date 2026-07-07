#!/usr/bin/env node
'use strict';

const { existsSync, mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const destructiveNamespaces = [
  'runs',
  'events',
  'pi_agent_sessions',
  'human_gates',
  'workflow_operations',
  'review_artifacts',
];

function main() {
  requireNode22();
  const options = parseArgs(process.argv.slice(2));
  const dbPath = options.dbPath ?? resolve(process.cwd(), options.dataDir ?? process.env.DATA_DIR ?? '.data', 'writing-assistant.sqlite');
  if (!existsSync(dbPath)) {
    console.log(JSON.stringify({ ok: true, applied: false, dbPath, message: 'database not found; nothing to reset' }, null, 2));
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    ensureSchema(db);
    const plan = buildPlan(db);
    if (!options.apply) {
      console.log(JSON.stringify({ ok: true, applied: false, dbPath, ...formatPlan(plan), hint: 'rerun with --apply to modify the database' }, null, 2));
      return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      applyArticleRevisionFixes(db, plan.articleRevisionFixes);
      applySessionRunReferenceFixes(db, plan.sessionRunReferenceFixes);
      for (const namespace of destructiveNamespaces) {
        db.prepare('DELETE FROM json_records WHERE namespace = ?').run(namespace);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log(JSON.stringify({ ok: true, applied: true, dbPath, ...formatPlan(plan) }, null, 2));
  } finally {
    db.close();
  }
}

function requireNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22) {
    throw new Error(`Node 22 is required. Current Node is ${process.version}. Run nvm use first.`);
  }
}

function parseArgs(args) {
  const options = { apply: false, dataDir: undefined, dbPath: undefined };
  for (const arg of args) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
    else if (arg.startsWith('--db=')) options.dbPath = resolve(arg.slice('--db='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS json_records (
      namespace TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, id)
    );
    CREATE INDEX IF NOT EXISTS idx_json_records_namespace_updated ON json_records(namespace, updated_at);
  `);
}

function buildPlan(db) {
  const namespaceCounts = Object.fromEntries(
    destructiveNamespaces.map((namespace) => [namespace, countNamespace(db, namespace)]),
  );
  const articleRows = db.prepare('SELECT id, json FROM json_records WHERE namespace = ?').all('artifacts');
  const articleRevisionFixes = articleRows
    .map((row) => {
      const article = JSON.parse(row.json);
      const fixed = normalizeArticleForPiWorkflow(article);
      return JSON.stringify(fixed) === row.json ? undefined : { id: row.id, article: fixed };
    })
    .filter(Boolean);
  const sessionRows = db.prepare('SELECT id, json FROM json_records WHERE namespace = ?').all('sessions');
  const sessionRunReferenceFixes = sessionRows
    .map((row) => {
      const session = JSON.parse(row.json);
      if (!session.currentRunId) return undefined;
      const { currentRunId: _currentRunId, ...withoutRun } = session;
      return { id: row.id, session: withoutRun };
    })
    .filter(Boolean);
  return {
    preservedNamespaces: ['artifacts', 'workspaces', 'sessions', 'memory', 'knowledge', 'dialogue_messages', 'dialogue_briefs', 'dialogue_brief_update_jobs', 'revision_proposals'],
    deletedNamespaces: namespaceCounts,
    articleRevisionFixCount: articleRevisionFixes.length,
    articleRevisionFixes,
    sessionRunReferenceFixCount: sessionRunReferenceFixes.length,
    sessionRunReferenceFixes,
  };
}

function formatPlan(plan) {
  return {
    preservedNamespaces: plan.preservedNamespaces,
    deletedNamespaces: plan.deletedNamespaces,
    articleRevisionFixCount: plan.articleRevisionFixCount,
    articleRevisionFixIds: plan.articleRevisionFixes.map((fix) => fix.id),
    sessionRunReferenceFixCount: plan.sessionRunReferenceFixCount,
    sessionRunReferenceFixIds: plan.sessionRunReferenceFixes.map((fix) => fix.id),
  };
}

function countNamespace(db, namespace) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM json_records WHERE namespace = ?').get(namespace);
  return row.count;
}

function normalizeArticleForPiWorkflow(article) {
  return {
    ...article,
    revision: Number.isInteger(article.revision) && article.revision > 0 ? article.revision : 1,
    comments: Array.isArray(article.comments) ? article.comments : [],
    versions: Array.isArray(article.versions) ? article.versions : [],
  };
}

function applyArticleRevisionFixes(db, fixes) {
  const update = db.prepare('UPDATE json_records SET json = ?, updated_at = ? WHERE namespace = ? AND id = ?');
  const updatedAt = new Date().toISOString();
  for (const fix of fixes) {
    update.run(JSON.stringify(fix.article), updatedAt, 'artifacts', fix.id);
  }
}

function applySessionRunReferenceFixes(db, fixes) {
  const update = db.prepare('UPDATE json_records SET json = ?, updated_at = ? WHERE namespace = ? AND id = ?');
  const updatedAt = new Date().toISOString();
  for (const fix of fixes) {
    update.run(JSON.stringify(fix.session), updatedAt, 'sessions', fix.id);
  }
}

main();
