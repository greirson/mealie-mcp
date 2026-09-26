import { apiRequest } from './api-request.js';
import { catalogTools } from './catalog.js';
import { mealplanTools } from './mealplans.js';
import { whoami } from './meta.js';
import { recipeTools } from './recipes.js';
import { shoppingTools } from './shopping.js';
import type { AnyToolDef } from './types.js';

export const allTools: readonly AnyToolDef[] = [
  whoami,
  ...recipeTools,
  ...mealplanTools,
  ...shoppingTools,
  ...catalogTools,
  apiRequest,
];
