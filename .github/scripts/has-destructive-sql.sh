#!/usr/bin/env bash
# Exit 0 if the SQL file contains a destructive statement (Law 25), otherwise exit 1.
# Newlines become spaces first, so a statement split across lines is still found.
# It matches statements, not single words, because "ON DELETE CASCADE" and "BEFORE DELETE" are safe.
tr '\n' ' ' < "$1" | grep -Eqi '\bDROP[[:space:]]+(TABLE|INDEX|VIEW|TRIGGER|COLUMN)\b|\bDELETE[[:space:]]+FROM\b|\bTRUNCATE\b|\bALTER\b[^;]*\b(RENAME|DROP)\b'
