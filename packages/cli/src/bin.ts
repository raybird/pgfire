#!/usr/bin/env node

import { Command } from 'commander';
import { Client } from 'pg';
import { TriggerManager } from '@pgfire/core';
import { PgFireServer, AuthManager } from '@pgfire/server';

const program = new Command();

program
  .name('pgfire')
  .description('PgFire CLI - Database migrations, tokens, and server management')
  .version('0.1.0');

// 1. Auth token 生成命令
const auth = program.command('auth').description('Authentication management');

auth
  .command('token')
  .description('Generate a scoped JWT token for PgFire clients')
  .requiredOption('--sub <subject>', 'Subject (e.g. client ID or user ID)')
  .option('--secret <secret>', 'JWT secret key (falls back to JWT_SECRET env)', process.env.JWT_SECRET || 'change-me')
  .option('--tables <tables>', 'Comma-separated list of allowed tables (defaults to all)')
  .option('--permissions <permissions>', 'Permissions: read, write, or readwrite', 'readwrite')
  .action((options) => {
    try {
      const { sub, secret, tables, permissions } = options;
      
      const tableList = tables ? tables.split(',').map((t: string) => t.trim()) : undefined;
      
      if (permissions !== 'read' && permissions !== 'write' && permissions !== 'readwrite') {
        console.error('Error: Permissions must be "read", "write", or "readwrite".');
        process.exit(1);
      }

      const authMgr = new AuthManager(secret);
      const token = authMgr.generateToken({
        sub,
        tables: tableList,
        permissions,
      });

      console.log('Generated JWT Token:');
      console.log(token);
    } catch (err) {
      console.error('Error generating token:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// 2. Server start 啟動命令
const server = program.command('server').description('Server management');

server
  .command('start')
  .description('Start the PgFire standalone SSE HTTP server')
  .option('-p, --port <port>', 'Port to listen on', process.env.PORT || '3000')
  .option('-h, --host <host>', 'Host to bind to', process.env.HOST || '0.0.0.0')
  .option('--secret <secret>', 'JWT secret key', process.env.JWT_SECRET || 'change-me')
  .action(async (options) => {
    try {
      const port = Number(options.port);
      const host = options.host;
      const secret = options.secret;

      // 檢查資料庫連接變數
      const dbConfig = {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT) || 5432,
        database: process.env.PGDATABASE || 'mydb',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
      };

      const pgServer = new PgFireServer({
        port,
        host,
        db: dbConfig,
        auth: {
          secret,
          required: true,
        },
      });

      console.log(`Connecting to PostgreSQL database: "${dbConfig.database}" on ${dbConfig.host}:${dbConfig.port}...`);
      await pgServer.start();
      console.log(`🚀 PgFire Server is running on http://${host}:${port}`);
      console.log(`Press Ctrl+C to stop`);

      // 處理關閉信號
      process.on('SIGINT', async () => {
        console.log('\nGracefully shutting down server...');
        await pgServer.stop();
        console.log('PgFire Server stopped.');
        process.exit(0);
      });
    } catch (err) {
      console.error('Error starting server:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// 3. Init / Migration 初始化命令
program
  .command('init')
  .description('Initialize PostgreSQL database with PgFire trigger functions')
  .action(async () => {
    try {
      const dbConfig = {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT) || 5432,
        database: process.env.PGDATABASE || 'mydb',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
      };

      console.log(`Connecting to database: "${dbConfig.database}" to install trigger function...`);
      const client = new Client(dbConfig);
      await client.connect();

      const triggerMgr = new TriggerManager(client);
      await triggerMgr.setupTriggerFunction();
      
      console.log('✅ Success: Installed pgfire_notify_trigger() function successfully.');
      await client.end();
      process.exit(0);
    } catch (err) {
      console.error('Error initializing database:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// 執行引數解析
program.parse(process.argv);
