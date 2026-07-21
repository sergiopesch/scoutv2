import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexMeetingAnalyzer } from "../server/codex/index.js";
import {
  buildAnalyzeMeetingInput,
  evaluateTranscriptGraph,
  parseTranscriptEvalFixture,
  type TranscriptEvalResult
} from "./transcript-eval.js";

interface CliOptions {
  fixturePaths: string[];
  outputPath?: string;
}

type TranscriptEvalRunResult =
  | TranscriptEvalResult
  | {
      fixtureId: string;
      passed: false;
      error: string;
    };

const parseArguments = (args: string[]): CliOptions => {
  const fixturePaths: string[] = [];
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output") {
      outputPath = args[index + 1];
      if (!outputPath) throw new Error("--output requires a file path.");
      index += 1;
    } else {
      fixturePaths.push(args[index]!);
    }
  }
  return { fixturePaths, outputPath };
};

const defaultFixturePaths = async (): Promise<string[]> => {
  const directory = path.resolve("evals/fixtures");
  return (await readdir(directory))
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(directory, entry));
};

const main = async (): Promise<void> => {
  const options = parseArguments(process.argv.slice(2));
  const fixturePaths =
    options.fixturePaths.length > 0
      ? options.fixturePaths.map((fixturePath) => path.resolve(fixturePath))
      : await defaultFixturePaths();
  if (fixturePaths.length === 0) {
    throw new Error("No transcript eval fixtures were found.");
  }

  const effort = process.env.CODEX_REASONING_EFFORT ?? "low";
  if (!["low", "medium", "high"].includes(effort)) {
    throw new Error("CODEX_REASONING_EFFORT must be low, medium, or high.");
  }
  const turnTimeoutMs = Number(
    process.env.TRANSCRIPT_EVAL_TIMEOUT_MS ?? 120_000
  );
  if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) {
    throw new Error("TRANSCRIPT_EVAL_TIMEOUT_MS must be a positive number.");
  }
  const analyzer = new CodexMeetingAnalyzer({
    model: process.env.CODEX_MODEL ?? "gpt-5.6-sol",
    effort: effort as "low" | "medium" | "high",
    turnTimeoutMs
  });
  const results: TranscriptEvalRunResult[] = [];

  try {
    for (const fixturePath of fixturePaths) {
      process.stderr.write(`Running transcript eval: ${fixturePath}\n`);
      try {
        const fixture = parseTranscriptEvalFixture(
          JSON.parse(await readFile(fixturePath, "utf8"))
        );
        const analysis = await analyzer.analyze(
          buildAnalyzeMeetingInput(
            fixture,
            `${fixture.id}-${results.length + 1}`
          )
        );
        const result = evaluateTranscriptGraph(fixture, analysis.graph);
        results.push(result);
        process.stderr.write(
          `${result.passed ? "PASS" : "FAIL"} ${fixture.id} (${result.assertions.filter(({ passed }) => passed).length}/${result.assertions.length} assertions)\n`
        );
      } catch (error) {
        const result: TranscriptEvalRunResult = {
          fixtureId: path.basename(fixturePath, path.extname(fixturePath)),
          passed: false,
          error: error instanceof Error ? error.message : String(error)
        };
        results.push(result);
        process.stderr.write(`ERROR ${result.fixtureId}: ${result.error}\n`);
      }
    }
  } finally {
    await analyzer.close();
  }

  const report = {
    passed: results.every(({ passed }) => passed),
    generatedAt: new Date().toISOString(),
    model: process.env.CODEX_MODEL ?? "gpt-5.6-sol",
    effort,
    results
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    await writeFile(path.resolve(options.outputPath), output, "utf8");
  } else {
    process.stdout.write(output);
  }
  if (!report.passed) process.exitCode = 1;
};

await main();
