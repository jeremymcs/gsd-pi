#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { resolveConfigPath, loadConfig } from './config.js';
import { Logger } from './logger.js';
import { Daemon } from './daemon.js';
import { install, uninstall, status } from './launchd.js';
import { clearCloudConfig, exchangePairingCode, redactedCloudStatus, saveCloudConfig } from './cloud-config.js';

const USAGE = `Usage: gsd-daemon [options]
       gsd-daemon cloud status [--config <path>]
       gsd-daemon cloud pair --gateway <url> --code <code> [--runtime-name <name>] [--config <path>]
       gsd-daemon cloud connect [--config <path>] [--verbose]
       gsd-daemon cloud disconnect [--config <path>]

Options:
  --config <path>  Path to YAML config file (default: ~/.gsd/daemon.yaml)
  --verbose        Print log entries to stderr in addition to the log file
  --install        Install the launchd LaunchAgent (auto-starts on login)
  --uninstall      Uninstall the launchd LaunchAgent
  --status         Show launchd agent status (registered, PID, exit code)
  --help           Show this help message and exit
`;

async function main(): Promise<void> {
  if (process.argv[2] === 'cloud') {
    await handleCloudCommand(process.argv.slice(3));
    return;
  }

  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      verbose: { type: 'boolean', short: 'v', default: false },
      install: { type: 'boolean', default: false },
      uninstall: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // --- launchd commands (dispatch before Daemon creation) ---

  if (values.install) {
    const configPath = resolveConfigPath(values.config);
    const thisFile = fileURLToPath(import.meta.url);
    const scriptPath = resolve(dirname(thisFile), 'cli.js');

    install({
      nodePath: process.execPath,
      scriptPath,
      configPath,
    });
    process.stdout.write('gsd-daemon: launchd agent installed and loaded.\n');
    process.exit(0);
  }

  if (values.uninstall) {
    uninstall();
    process.stdout.write('gsd-daemon: launchd agent uninstalled.\n');
    process.exit(0);
  }

  if (values.status) {
    const result = status();
    if (!result.registered) {
      process.stdout.write('gsd-daemon: not registered with launchd.\n');
    } else if (result.pid != null) {
      process.stdout.write(
        `gsd-daemon: running (PID ${result.pid}, last exit status: ${result.lastExitStatus ?? 'n/a'})\n`,
      );
    } else {
      process.stdout.write(
        `gsd-daemon: registered but not running (last exit status: ${result.lastExitStatus ?? 'n/a'})\n`,
      );
    }
    process.exit(0);
  }

  // --- normal daemon start ---

  const configPath = resolveConfigPath(values.config);
  const config = loadConfig(configPath);

  const logger = new Logger({
    filePath: config.log.file,
    level: config.log.level,
    verbose: values.verbose,
  });

  const daemon = new Daemon(config, logger);
  await daemon.start();
}

async function handleCloudCommand(argv: string[]): Promise<void> {
  const command = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: 'string', short: 'c' },
      gateway: { type: 'string' },
      code: { type: 'string' },
      'runtime-name': { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help || !command) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const configPath = resolveConfigPath(values.config);
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(redactedCloudStatus(loadConfig(configPath)), null, 2)}\n`);
    return;
  }

  if (command === 'disconnect') {
    clearCloudConfig(configPath);
    process.stdout.write('gsd-daemon: cloud runtime disconnected locally.\n');
    return;
  }

  if (command === 'pair') {
    if (!values.gateway || !values.code) {
      throw new Error('cloud pair requires --gateway and --code');
    }
    const runtimeName = values['runtime-name'];
    const result = await exchangePairingCode({
      gatewayUrl: values.gateway,
      code: values.code,
      runtimeName,
    });
    saveCloudConfig(configPath, {
      gateway_url: values.gateway,
      device_token: result.deviceToken,
      runtime_id: result.runtimeId,
      ...(runtimeName ? { runtime_name: runtimeName } : {}),
      enabled: true,
    });
    process.stdout.write(`gsd-daemon: paired cloud runtime ${result.runtimeId}.\n`);
    return;
  }

  if (command === 'connect') {
    const config = loadConfig(configPath);
    if (!config.cloud?.device_token || !config.cloud.runtime_id) {
      throw new Error('cloud runtime is not paired; run `gsd-daemon cloud pair` first');
    }
    const logger = new Logger({
      filePath: config.log.file,
      level: config.log.level,
      verbose: values.verbose,
    });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    return;
  }

  throw new Error(`Unknown cloud command: ${command}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gsd-daemon: fatal: ${msg}\n`);
  process.exit(1);
});
