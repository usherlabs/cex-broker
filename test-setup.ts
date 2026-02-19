// Test setup file
import { afterAll, beforeAll } from "bun:test";

// Set up test environment
beforeAll(() => {
	// Set test environment variables
	process.env.NODE_ENV = "test";

	// Mock console methods to reduce noise in tests
	const originalConsole = { ...console };
	console.log = () => {};
	console.warn = () => {};

	// Restore console after tests
	afterAll(() => {
		console.log = originalConsole.log;
		console.warn = originalConsole.warn;
	});
});
