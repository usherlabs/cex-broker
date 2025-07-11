#!/usr/bin/env bun

import { Command } from 'commander';
import { startBrokerCommand } from '../commands/start-broker';

const program = new Command();

program
  .name('cex-broker')
  .description('CLI to start the CEXBroker service')
  .requiredOption('-p, --policy <path>', 'Policy JSON file')
  .option('--port <number>', 'Port number (default: 8086)', '8086')
  .action(async (options) => {
    try {
      await startBrokerCommand(
        options.policy,
        parseInt(options.port, 10)
    );
    } catch (err) {
      console.error('❌ Failed to start broker:', err);
      process.exit(1);
    }
  });

program.parse(process.argv);
