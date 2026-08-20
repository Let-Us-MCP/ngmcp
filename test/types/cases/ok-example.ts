// @expect: compiles
/* The shipped example, type-checked here so it cannot drift.
 * If the components stop accepting what the example passes them, or the
 * contract stops carrying its types, this stops compiling. */
export { contracts } from "./example-contract.js";
