# Newmark Flow Format Guide

A Flow workflow is saved as name.Flow.json in the Flow/ folder.

## Component Types
### dialog - id, type:"dialog", mode:"build"/"plan"/"goal", prompt (use {#prompt#} placeholder)
### logic - id, type:"logic", prompt, goto_true, goto_false

Components execute in order unless logic redirects.