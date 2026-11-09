import { buildCaseVisualization } from './visualizeCase';

const PUBLIC_SOLUTION = `import java.util.*;

public class Solution {
    public List<String> findFraudulentUsers(List<List<Object>> transactions, int k, int window_seconds) {
        return new ArrayList<>();
    }
}
`;

const PACKAGE_PRIVATE_SOLUTION = `import java.util.*;

class Solution {
    public List<String> findFraudulentUsers(List<List<Object>> transactions, int k, int window_seconds) {
        return new ArrayList<>();
    }
}
`;

describe('buildCaseVisualization - java', () => {
  it('demotes a public entry class to package-private so the harness compiles as Main.java', () => {
    const out = buildCaseVisualization('java', PUBLIC_SOLUTION, 'Solution.findFraudulentUsers', [[['u1', 1]], 1, 10]);
    expect(out).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(out).toMatch(/\bclass\s+Solution\b/);
    expect(out).toMatch(/\bpublic\s+class\s+Main\b/);
    // The generated Main still reaches the entry class by reflection
    // and by instantiation in the same file.
    expect(out).toContain('Solution.class.getDeclaredMethods()');
    expect(out).toContain('new Solution()');
  });

  it('demotes a public entry class for a bare method entry too', () => {
    const out = buildCaseVisualization('java', PUBLIC_SOLUTION, 'findFraudulentUsers', [[['u1', 1]], 1, 10]);
    expect(out).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(out).toMatch(/\bclass\s+Solution\b/);
  });

  it('leaves a package-private entry class unchanged', () => {
    const out = buildCaseVisualization('java', PACKAGE_PRIVATE_SOLUTION, 'Solution.findFraudulentUsers', [[['u1', 1]], 1, 10]);
    expect(out).toContain('class Solution {');
    expect(out).not.toMatch(/\bpublic\s+class\s+Solution\b/);
  });

  it('keeps final/abstract modifiers when demoting the entry class', () => {
    const finalOut = buildCaseVisualization(
      'java',
      PUBLIC_SOLUTION.replace('public class Solution', 'public final class Solution'),
      'Solution.findFraudulentUsers',
      [[['u1', 1]], 1, 10]
    );
    expect(finalOut).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(finalOut).toMatch(/\bfinal\s+class\s+Solution\b/);

    const abstractOut = buildCaseVisualization(
      'java',
      PUBLIC_SOLUTION.replace('public class Solution', 'public abstract class Solution'),
      'Solution.findFraudulentUsers',
      [[['u1', 1]], 1, 10]
    );
    expect(abstractOut).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(abstractOut).toMatch(/\babstract\s+class\s+Solution\b/);
  });

  it('still rejects a file that already defines a Main class', () => {
    expect(() =>
      buildCaseVisualization('java', `${PUBLIC_SOLUTION}\npublic class Main {}`, 'Solution.findFraudulentUsers', [[], 1, 10])
    ).toThrow(/already defines a Main/);
  });

  it('still rejects a file without the entry class', () => {
    expect(() =>
      buildCaseVisualization('java', 'class Other {\n    public void f() {}\n}', 'Solution.findFraudulentUsers', [[], 1, 10])
    ).toThrow(/needs a class Solution/);
  });
});
