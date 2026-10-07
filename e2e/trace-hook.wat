;; Minimal hook for the debugstream e2e check: traces "xng debugstream", then accepts.
(module
  (import "env" "_g" (func $_g (param i32 i32) (result i32)))
  (import "env" "trace" (func $trace (param i32 i32 i32 i32 i32) (result i64)))
  (import "env" "accept" (func $accept (param i32 i32 i64) (result i64)))
  (memory (export "memory") 1)
  (data (i32.const 0) "xng debugstream")
  (func (export "hook") (param i32) (result i64)
    (drop (call $_g (i32.const 1) (i32.const 1)))
    (drop (call $trace (i32.const 0) (i32.const 15) (i32.const 0) (i32.const 0) (i32.const 0)))
    (call $accept (i32.const 0) (i32.const 0) (i64.const 0))))
