import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.TIGER_DATABASE_URL) {
  console.error('Error: TIGER_DATABASE_URL environment variable not set.');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.TIGER_DATABASE_URL });
await client.connect();
console.log('Connected. Applying schema...');

const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
await client.query(sql);
await client.end();
console.log('Schema applied successfully.');
