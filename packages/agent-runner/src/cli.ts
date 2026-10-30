#!/usr/bin/env node
import process from "node:process";
import { runHeadlessEditFile } from "./run";
import { resolveLlmProvider, type LlmProvider } from "./node-llm";

interface CliArgs {
  project?: string;
  prompt?: string;
  provider: LlmProvider;
  providerError?: string;
  model?: string;
  out?: string;
  dryRun: boolean;
}

const PROVIDERS: readonly LlmProvider[] = ["auto", "omni", "cloudflare", "anthropic", "openai"];

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { provider: "auto", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => argv[++i] ?? "";
    switch (arg) {
      case "--project":
      case "-p":
        args.project = next();
        break;
      case "--prompt":
      case "-m":
        args.prompt = next();
        break;
      case "--provider": {
        const value = next() as LlmProvider;
        if (PROVIDERS.includes(value)) {
          args.provider = value;
        } else {
          args.providerError = `Unknown provider '${value}'. Expected one of: ${PROVIDERS.join(", ")}.`;
        }
        break;
      }
      case "--model":
        args.model = next();
        break;
      case "--out":
      case "-o":
        args.out = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function resolveApiKey(provider: LlmProvider): string {
  return (
    process.env.KOVE_ADVANCED_API_KEY ??
    (provider === "openai"
      ? process.env.OPENAI_API_KEY
      : process.env.ANTHROPIC_API_KEY) ??
    ""
  );
}

const DEFAULT_MODEL: Partial<Record<LlmProvider, string>> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-sol",
};

const USAGE = `kove-advanced-agent — headless project editing

Usage:
  kove-advanced-agent --project <file.json> --prompt "<instruction>" [options]

Options:
  -p, --project <path>   Project JSON to edit (required)
  -m, --prompt  <text>   Natural-language editing instruction (required)
      --provider <name>  auto | omni | cloudflare | anthropic | openai (default: auto)
      --model <id>       Model id (default: provider default / gateway pin)
  -o, --out <path>       Output path (default: edit in place)
      --dry-run          Plan without applying mutations

Provider ladder (auto): OmniRoute gateway (.dev.vars/env) first, Cloudflare
Workers AI second, direct anthropic/openai endpoints last. 'omni' keeps
Workers as its secondary; 'cloudflare' | 'anthropic' | 'openai' force a side.

API keys (never stored): OMNIROUTE_KEY / CLOUDFLARE_API_TOKEN come from env or
.dev.vars; anthropic/openai use KOVE_ADVANCED_API_KEY, ANTHROPIC_API_KEY, or
OPENAI_API_KEY.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project || !args.prompt) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(args.project || args.prompt ? 1 : 0);
  }
  if (args.providerError) {
    process.stderr.write(`${args.providerError}\n`);
    process.exit(1);
  }
  const provider = resolveLlmProvider(args.provider);
  const keyless = provider === "omni" || provider === "cloudflare";
  const apiKey = keyless ? "" : resolveApiKey(provider);
  if (!keyless && !apiKey) {
    process.stderr.write(
      `No API key found. Set KOVE_ADVANCED_API_KEY (or ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}).\n`,
    );
    process.exit(1);
  }

  const model = args.model ?? DEFAULT_MODEL[provider];
  const log = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Primary LLM failed (${message}) — falling back to Cloudflare Workers AI.\n`);
  };
  try {
    const { result, saved } = await runHeadlessEditFile({
      projectPath: args.project,
      prompt: args.prompt,
      provider,
      model,
      apiKey,
      outPath: args.out,
      dryRun: args.dryRun,
      onFallback: log,
    });
    const usage = `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`;
    process.stdout.write(
      `Done (${result.stoppedReason}). ${result.toolCalls} tool call(s), ${usage}.\n` +
        (saved
          ? `Saved to ${args.out ?? args.project}.\n`
          : `Not saved${args.dryRun ? " (dry-run)" : result.stoppedReason === "error" ? " (turn errored)" : ""}.\n`),
    );
    process.exit(result.stoppedReason === "error" ? 1 : 0);
  } catch (error) {
    process.stderr.write(
      `Headless run failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
