#!/usr/bin/env bash
# Exit 0 if the SQL file contains a destructive statement (Law 25), otherwise exit 1.
# Newlines become spaces first, so a statement split across lines is still found.
tr '\n' ' ' < "$1" | grep -Eqi '\b(DROP|DELETE|TRUNCATE)\b|\bALTER\b[^;]*\bRENAME\b'
