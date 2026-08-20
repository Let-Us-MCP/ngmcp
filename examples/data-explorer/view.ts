/** The view. Note what is absent: no `?.`, no `?? []`, no shape written twice.
 *
 * `contracts` is imported as a type only, so nothing of the server reaches
 * this bundle. What survives is the knowledge of what `list_deployments`
 * returns, which is the whole point.
 */
import type { contracts, Deployment } from "./contract.js";
import {
  client, hostBridge, dataTable, metric, card, columns, stack, toaster, button,
  signal,
} from "../../src/view/index.js";

const notes = toaster();
const api = client<typeof contracts>({ bridge: hostBridge() });

const rows = signal<readonly Deployment[]>([]);
const failing = () => rows().filter((d) => d.errors > 0).length;

const table = dataTable<Deployment>({
  rows,
  columns: [
    { key: "service", label: "Service" },
    { key: "env", label: "Environment" },
    { key: "errors", label: "Errors", align: "end" },
  ],
  selection: "single",
  filterLabel: "Filter deployments",
});

const restart = button({
  label: "Restart selected",
  disabled: () => table.selected().length === 0,
  onActivate: async () => {
    const id = table.selected()[0];
    if (!id) return;
    // Typed: `id` is required, and the result is known to carry `service`.
    const { service } = await api.restart({ id });
    notes.show(`Restarted ${service}`, "success");
  },
});

document.getElementById("root")!.append(
  stack({},
    columns({ weights: [1, 1] },
      card({ title: "Deployments" },
        metric({ label: "Total", value: () => rows().length }).el),
      card({ title: "Failing" },
        metric({
          label: "With errors",
          value: failing,
          state: () => (failing() > 0 ? "bad" : "ok"),
        }).el)),
    card({ title: "All deployments", actions: [restart.el] }, table.el),
    notes.el));

const loaded = await api.list_deployments({});
rows.set(loaded.deployments);
document.documentElement.dataset.ready = "1";
