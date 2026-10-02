/** Registers the JSX hooks for `node --import ./scripts/jsx-register.mjs`. */
import { register } from 'node:module'

register('./jsx-hooks.mjs', import.meta.url)
