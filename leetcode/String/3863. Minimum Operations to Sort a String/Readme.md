# 3863. Minimum Operations to Sort a String

**Medium**

You are given a string `s` consisting of lowercase English letters.

In one operation, you can select any substring of `s` that is **not** the entire string and **sort** it in **non-descending** alphabetical order.

Return the **minimum** number of operations required to make `s` sorted in **non-descending** order. If it is not possible, return `-1`.

**Example 1:**

> **Input:** s = "dog"
>
> **Output:** 1
>
> **Explanation:**
>
> - Sort substring "og" to "go".
> - Now, s = "dgo", which is sorted in ascending order. Thus, the answer is 1.

**Example 2:**

> **Input:** s = "card"
>
> **Output:** 2
>
> **Explanation:**
>
> - Sort substring "car" to "acr", so s = "acrd".
> - Sort substring "rd" to "dr", so s = "acdr", which is sorted. Thus, the answer is 2.

Write your solution in `code.py`, `code.java` or `code.js` (a `Solution` class / function named `minOperations`), then run the test cases in the **Testcase** panel below the code pad. The page ships its cases in `tests.json`; you can edit or add cases in the panel.
