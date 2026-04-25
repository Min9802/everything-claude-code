const assert = require('assert');

const { toBashScriptPath } = require('../../scripts/hooks/plugin-hook-bootstrap');

function test(name, fn) {
    try {
        fn();
        console.log(`  \u2713 ${name}`);
        return true;
    } catch (error) {
        console.log(`  \u2717 ${name}`);
        console.log(`    Error: ${error.message}`);
        return false;
    }
}

function runTests() {
    console.log('\n=== Testing plugin-hook-bootstrap path normalization ===\n');

    let passed = 0;
    let failed = 0;

    if (test('toBashScriptPath keeps non-windows paths unchanged', () => {
        const input = '/tmp/scripts/run-with-flags-shell.sh';
        const output = toBashScriptPath(input);

        if (process.platform === 'win32') {
            assert.strictEqual(output, '/tmp/scripts/run-with-flags-shell.sh');
        } else {
            assert.strictEqual(output, input);
        }
    })) passed++; else failed++;

    if (test('toBashScriptPath converts absolute windows path for bash', () => {
        const input = 'C:\\Users\\Min\\.vscode\\agent-plugins\\github.com\\affaan-m\\everything-claude-code\\scripts\\hooks\\run-with-flags-shell.sh';
        const output = toBashScriptPath(input);

        if (process.platform === 'win32') {
            assert.strictEqual(output, '/c/Users/Min/.vscode/agent-plugins/github.com/affaan-m/everything-claude-code/scripts/hooks/run-with-flags-shell.sh');
        } else {
            assert.strictEqual(output, input);
        }
    })) passed++; else failed++;

    console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests();
