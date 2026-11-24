if .op == "input" then input
elif .op == "halt" then halt
elif .op == "halt_error" then halt_error
elif .op == "loop" then until(false; .)
elif .op == "error" then error({code: 1})
else . end
