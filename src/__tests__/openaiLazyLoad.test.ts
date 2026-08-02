// Regression guard: importing OpenAI-using services must not require
// OPENAI_API_KEY at module load time.
//
// HOW THE GUARD FIRES: the OpenAI constructor throws
// "The OPENAI_API_KEY environment variable is missing or empty" when the key
// is absent. jest.isolateModules() forces a fresh module registry so each
// require() re-executes module-level code from scratch. If any file reverts
// to import-time construction the throw propagates out of isolateModules() and
// the expect(...).not.toThrow() assertion fails.

const savedKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (savedKey !== undefined) {
    process.env.OPENAI_API_KEY = savedKey;
  }
});

describe('OpenAI lazy construction — no OPENAI_API_KEY required at import time', () => {
  it('userService loads without OPENAI_API_KEY', () => {
    expect(() => {
      jest.isolateModules(() => {
        require('../services/userService');
      });
    }).not.toThrow();
  });

  it('matchingService loads without OPENAI_API_KEY', () => {
    expect(() => {
      jest.isolateModules(() => {
        require('../services/matchingService');
      });
    }).not.toThrow();
  });

  it('chatService loads without OPENAI_API_KEY', () => {
    expect(() => {
      jest.isolateModules(() => {
        require('../services/chatService');
      });
    }).not.toThrow();
  });

  it('preferenceLearningService loads without OPENAI_API_KEY', () => {
    expect(() => {
      jest.isolateModules(() => {
        require('../services/preferenceLearningService');
      });
    }).not.toThrow();
  });

  it('matchRoutes loads without OPENAI_API_KEY (full transitive chain)', () => {
    expect(() => {
      jest.isolateModules(() => {
        require('../routes/matchRoutes');
      });
    }).not.toThrow();
  });
});
