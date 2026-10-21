# import visualization libraries {
from algorithm_visualizer import GraphTracer, HorizontalLayout, Layout, LogTracer, Tracer, VerticalLayout
# }


# Definition for a Node.
class Node:
    def __init__(self, val=0, neighbors=None):
        self.val = val
        self.neighbors = neighbors if neighbors is not None else []


# define tracer variables {
original_graph_tracer = GraphTracer('Original Graph')
cloned_graph_tracer = GraphTracer('Cloned Graph')
log_tracer = LogTracer('Console')
# }

# define input variables
adjList = [
    [2, 4],
    [1, 3],
    [2, 4],
    [1, 3],
]

N = len(adjList)
adj_matrix = [[0] * N for _ in range(N)]
for i, neighbors in enumerate(adjList):
    for neighbor in neighbors:
        adj_matrix[i][neighbor - 1] = 1

cloned_matrix = [[0] * N for _ in range(N)]


def build_graph(adj_list):
    if not adj_list:
        return None
    nodes = [Node(i + 1) for i in range(len(adj_list))]
    for i, neighbors in enumerate(adj_list):
        nodes[i].neighbors = [nodes[n - 1] for n in neighbors]
    return nodes[0]


def cloneGraph(node: 'Node') -> 'Node':
    if not node:
        return None

    cloned = {}

    def dfs(curr: 'Node') -> 'Node':
        # visualize {
        log_tracer.println(f'Visiting original node {curr.val}')
        original_graph_tracer.visit(curr.val - 1)
        Tracer.delay()
        # }

        copy = Node(curr.val)
        cloned[curr] = copy

        # visualize {
        log_tracer.println(f'Cloned node {curr.val}')
        cloned_graph_tracer.visit(curr.val - 1)
        Tracer.delay()
        # }

        for neighbor in curr.neighbors:
            u = curr.val - 1
            v = neighbor.val - 1

            if neighbor in cloned:
                # visualize {
                log_tracer.println(f'Neighbor {neighbor.val} of node {curr.val} already cloned')
                # }
                copy.neighbors.append(cloned[neighbor])
            else:
                # visualize {
                log_tracer.println(f'Neighbor {neighbor.val} of node {curr.val} not cloned yet; traversing...')
                # }
                cloned_neighbor = dfs(neighbor)
                copy.neighbors.append(cloned_neighbor)

            # visualize {
            if cloned_matrix[u][v] == 0:
                cloned_matrix[u][v] = 1
                cloned_matrix[v][u] = 1
                cloned_graph_tracer.set(cloned_matrix)
                log_tracer.println(f'Connected cloned node {curr.val} to {neighbor.val}')
                cloned_graph_tracer.visit(v, u)
                Tracer.delay()
                cloned_graph_tracer.leave(v, u)
            # }

        # visualize {
        original_graph_tracer.leave(curr.val - 1)
        cloned_graph_tracer.leave(curr.val - 1)
        Tracer.delay()
        # }

        return copy

    return dfs(node)


clone_graph = cloneGraph


def main():
    if not adjList:
        log_tracer.println('Adjacency list is empty.')
        return

    # visualize {
    Layout.set_root(VerticalLayout([
        HorizontalLayout([original_graph_tracer, cloned_graph_tracer]),
        log_tracer,
    ]))
    original_graph_tracer.set(adj_matrix)
    original_graph_tracer.directed(False)
    cloned_graph_tracer.set(cloned_matrix)
    cloned_graph_tracer.directed(False)
    Tracer.delay()
    # }

    root = build_graph(adjList)
    cloneGraph(root)


main()
