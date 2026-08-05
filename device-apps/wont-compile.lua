-- wont-compile.lua — a test fixture that is SUPPOSED to fail.
--
-- Exercises the error channel the way runaway.lua exercises the escape hatch.
-- Pushing this used to be indistinguishable from pushing nothing: the hub
-- returned 200 (it delivered fine — that is all the relay ever promised), the
-- panel kept showing the previous app, and the reason lived only on a serial
-- port nobody was watching.
--
-- Now the runtime's `compile_error` telemetry reaches the hub, so:
--
--     ./send-app.sh device-apps/wont-compile.lua
--     curl -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
--          https://<your-hub>/hub/device/events | jq '.events[0]'
--
-- should show name="compile_error" with the Lua message in data.error.
--
-- Safe to push: it never compiles, so it never draws, so the panel is
-- untouched and the previously persisted app stays persisted.

function init(ctx)
  screen.clear()
  -- Deliberate syntax error: unterminated string literal. Chosen over a subtler
  -- fault because the point is to assert the message SURVIVES the trip, and a
  -- parser error carries a line number worth reading at the other end.
  screen.text(40, 60, 'this string never closes, 6)
  screen.flip()
end
