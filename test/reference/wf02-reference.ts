import { readFileSync } from "node:fs";

/**
 * Runs WF-02's own exported Code nodes, in WF-02's wiring order, outside n8n.
 *
 * This is the reference the port is held to (ADR-0004). It stands in for the
 * n8n runtime with the smallest shim the vendored code touches: `$input`,
 * `$('Node')`, `$json` and `$execution`. HTTP nodes are replaced by the
 * scenario's inputs, and the Claude call by canned reply text.
 */

type Json = Record<string, unknown>;
type Item = { json: Json };
type NodeFn = (...args: unknown[]) => Promise<unknown>;

interface ReferenceNode {
  mode: "runOnceForAllItems" | "runOnceForEachItem";
  code: string;
}

const reference = JSON.parse(
  readFileSync(new URL("./wf-02-code-nodes.json", import.meta.url), "utf8"),
) as { nodes: Record<string, ReferenceNode> };

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...params: string[]
) => NodeFn;

const silent = { log() {}, warn() {}, error() {} };
const execution = { id: "reference" };

function selector(outputs: Record<string, Item[]>, index: number) {
  return (name: string) => {
    const items = outputs[name];
    // Mirrors n8n: referencing a node that did not run throws.
    if (!items) throw new Error(`Node "${name}" has not executed`);
    return { first: () => items[0], all: () => items, item: items[index] };
  };
}

function asItems(result: unknown): Item[] {
  const list = Array.isArray(result) ? result : [result];
  return list.map((entry) =>
    entry && typeof entry === "object" && "json" in entry ? (entry as Item) : { json: entry as Json },
  );
}

async function runNode(name: string, input: Item[], outputs: Record<string, Item[]>): Promise<Item[]> {
  const node = reference.nodes[name];
  const fn = new AsyncFunction("$input", "$", "$json", "$execution", "$prevNode", "console", node.code);

  if (node.mode === "runOnceForEachItem") {
    const out: Item[] = [];
    for (let index = 0; index < input.length; index++) {
      const $input = { item: input[index], first: () => input[0], all: () => input };
      const result = await fn($input, selector(outputs, index), input[index].json, execution, null, silent);
      out.push(...asItems(result));
    }
    return out;
  }

  const $input = { item: input[0], first: () => input[0], all: () => input };
  return asItems(await fn($input, selector(outputs, 0), input[0]?.json, execution, null, silent));
}

export interface ReferenceScenario {
  products: Json[];
  baseline: Json[];
  competitor: { id: string; name: string; domain: string };
  runId: string;
  datasetId: string;
  /** Claude's reply text for the change at `index`, or null when the API call failed. */
  reply: (index: number) => string | null;
}

export interface ReferenceResult {
  changes: Json[];
  prompts: Json[];
  alerts: Json[];
  baselineRows: Json[];
}

export async function runWf02Reference(scenario: ReferenceScenario): Promise<ReferenceResult> {
  const outputs: Record<string, Item[]> = {
    "Validate Payload": [{ json: { actorRunId: scenario.runId, datasetId: scenario.datasetId } }],
    "Get Dataset": scenario.products.map((json) => ({ json })),
    "Check Competitor": [
      {
        json: {
          competitor_id: scenario.competitor.id,
          competitor_name: scenario.competitor.name,
          domain: scenario.competitor.domain,
        },
      },
    ],
  };

  // Load Price State answers `[]` for a competitor with no Baseline, and Build
  // Context still ran on first runs (it filters out the empty item), so an
  // empty Baseline reaches it as one empty item rather than none.
  const state = scenario.baseline.length ? scenario.baseline.map((json) => ({ json })) : [{ json: {} }];
  outputs["Build Context"] = await runNode("Build Context", state, outputs);

  const context = outputs["Build Context"];
  const priceRows = await runNode("Build Price Rows", context, outputs);

  // Merge Alerts appends its three inputs in order; Changes Found keeps items
  // that are not `_no_changes` markers.
  const merged = [
    ...(await runNode("Diff Price", context, outputs)),
    ...(await runNode("Diff Catalog", context, outputs)),
    ...(await runNode("Diff Promo", context, outputs)),
  ];
  const changes = merged.filter((item) => item.json._no_changes !== true);

  const result: ReferenceResult = {
    changes: changes.map((item) => item.json),
    prompts: [],
    alerts: [],
    baselineRows: priceRows[0].json.rows as Json[],
  };
  if (changes.length === 0) return result;

  outputs["Build Claude Prompt"] = await runNode("Build Claude Prompt", changes, outputs);
  result.prompts = outputs["Build Claude Prompt"].map((item) => JSON.parse(String(item.json.body)) as Json);

  const replies = changes.map((_, index) => scenario.reply(index));
  let interpreted: Item[];
  if (replies.every((reply) => reply !== null)) {
    const responses = replies.map((text) => ({ json: { content: [{ type: "text", text }] } }));
    interpreted = await runNode("Parse Claude", responses, outputs);
  } else if (replies.every((reply) => reply === null)) {
    interpreted = await runNode(
      "Claude Error Handler",
      [{ json: { error: { message: "Claude API call failed" } } }],
      outputs,
    );
  } else {
    // WF-02's error handler marks every pending alert failed when any one call
    // fails, so a mixed outcome has no single reference answer to compare with.
    throw new Error("Mixed Claude success and failure is not modelled by the reference");
  }

  const normalized = await runNode("Normalize Alert", interpreted, outputs);
  // `workflow` and `execution_id` identify the n8n run, not the change.
  result.alerts = normalized.map(({ json }) => {
    const alert = { ...json };
    delete alert.workflow;
    delete alert.execution_id;
    return alert;
  });
  return result;
}
