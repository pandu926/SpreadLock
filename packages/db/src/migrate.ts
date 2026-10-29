import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

export async function migrate(pool: Pool, directory=resolve('packages/db/migrations')) {
  const client=await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(764214380)');
    await client.query('CREATE TABLE IF NOT EXISTS spreadlock_schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const files=(await readdir(directory)).filter(f=>/^\d+_[a-z0-9_]+\.sql$/.test(f)).sort();
    for(const file of files){
      const sql=await readFile(resolve(directory,file),'utf8');
      const checksum=createHash('sha256').update(sql).digest('hex');
      const existing=await client.query<{checksum:string}>('SELECT checksum FROM spreadlock_schema_migrations WHERE name=$1',[file]);
      if(existing.rows[0]){if(existing.rows[0].checksum!==checksum)throw new Error(`Migration checksum changed: ${file}`);continue;}
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO spreadlock_schema_migrations(name,checksum) VALUES($1,$2)',[file,checksum]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}
    }
  }finally{
    await client.query('SELECT pg_advisory_unlock(764214380)').catch(()=>{});
    client.release();
  }
}
