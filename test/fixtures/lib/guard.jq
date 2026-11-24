# Rejects queries that the view does not allow.
def no_service: if [.. | objects | select(.type == "service")] | length > 0
  then error("SERVICE is not allowed in this view") else . end;
