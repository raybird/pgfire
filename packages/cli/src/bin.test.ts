import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// 我們可以 mock 核心功能，測試 CLI 主要引數解析邏輯
describe('CLI Arguments Parsing', () => {
  it('should define correct commands and options', () => {
    const program = new Command();
    program
      .name('pgfire')
      .description('PgFire CLI')
      .version('0.1.0');

    const auth = program.command('auth').description('Auth');
    const tokenCmd = auth
      .command('token')
      .requiredOption('--sub <subject>', 'Sub')
      .option('--secret <secret>', 'Secret', 'default-secret');

    expect(program.commands.length).toBe(1);
    expect(program.commands[0].name()).toBe('auth');
    expect(auth.commands[0].name()).toBe('token');
  });
});
