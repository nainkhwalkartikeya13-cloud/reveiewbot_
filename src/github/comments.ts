// This module's functionality has been consolidated into src/github/app.ts
// Re-export for backward compatibility with any code that imports from here.

export {
    fetchPRDiff,
    postReview as postReviewComments,
    postIssueComment as postPRComment,
    type ReviewComment,
} from './app.js';
