-- Draw once, then do nothing: quiesces the panel for safe reflashing.
function init(ctx)
  screen.clear()
  screen.text(40, 200, 'Standby - safe to reflash', 4)
  screen.flip('quality')
end
