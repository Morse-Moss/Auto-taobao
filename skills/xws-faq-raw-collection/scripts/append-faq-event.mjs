#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [eventsPath, eventJson] = process.argv.slice(2);
if (!eventsPath || !eventJson) throw new Error('Usage: append-faq-event.mjs <events.jsonl> <json-event>');
const event = JSON.parse(eventJson);
if (!event.event || !event.productId || !event.at) throw new Error('Event requires at, productId, and event');
await mkdir(dirname(resolve(eventsPath)), { recursive: true });
await appendFile(resolve(eventsPath), `${JSON.stringify(event)}\n`, 'utf8');
