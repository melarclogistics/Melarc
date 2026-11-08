/**
 * The names under which the HTTP pipeline keeps facts about one response on `response.locals`. A module of its own, with no
 * imports, so that the logging, the exception filter and the pipeline can each name them without importing one another.
 */

/** Why transport admission refused the request, for the one completion line it writes (`logging/request-middleware.ts`). */
export const TRANSPORT_REFUSAL_KEY = 'transportRefusal';

/**
 * Set when the pipeline answered a request in the place of its work, which went on (`admission/request-budget.ts`). The work's
 * own end, success or failure, then finds the response already sent; the filter reads this to tell that from a defect.
 */
export const PIPELINE_ANSWER_KEY = 'pipelineAnswered';
