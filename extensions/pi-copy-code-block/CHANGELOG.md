# @haphazarddev/pi-copy-code-block

## 0.2.1

### Patch Changes

- 1121430: Remove the extra trailing newline when copying code blocks so single-line commands paste cleanly.

## 0.2.0

### Minor Changes

- 119ea7b: Update these extensions to the new `@earendil-works/*` pi package scope.

  Consumers should install the new `@earendil-works` pi packages to satisfy peer dependencies. `@haphazarddev/pi-copy-code-block` also switches its direct clipboard dependency from `@mariozechner/clipboard` to `clipboardy`.
