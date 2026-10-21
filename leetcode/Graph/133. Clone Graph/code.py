# import visualization libraries {
from algorithm_visualizer import (
    Array1DTracer,
    Array2DTracer,
    GraphTracer,
    HorizontalLayout,
    Layout,
    LogTracer,
    Tracer,
    VerticalLayout,
)
# }

# define tracer variables {
graph_tracer = GraphTracer('Original Graph')
clone_matrix_tracer = Array2DTracer('Cloned Graph (Adjacency Matrix)')
clone_map_tracer = Array1DTracer('Cloned Nodes Map')
log_tracer = LogTracer('Console')
# }


# Definition for a Node.
class Node:

    def __init__(self, val=0, neighbors=None):
        self.val = val
        self.neighbors = neighbors if neighbors is not None else []


# define input variables (Example 1: adjList = [[2,4],[1,3],[2,4],[1,3]])
adj_list_input = [
    [2, 4],  # Node 1
    [1, 3],  # Node 2
    [2, 4],  # Node 3
    [1, 3],  # Node 4
]

n = len(adj_list_input)
cloned_map = {}
cloned_matrix = [[0] * n for _ in range(n)]
clone_status = ['-'] * n


def build_graph(adj_list):
    if not adj_list:
        return None
    nodes = [Node(i + 1) for i in range(len(adj_list))]
    for i, neighbors in enumerate(adj_list):
        nodes[i].neighbors = [nodes[nbr - 1] for nbr in neighbors]
    return nodes[0]


def clone_graph(node):
    if not node:
        return None

    # visualize {
    log_tracer.println(f'Visiting Node {node.val}')
    graph_tracer.visit(node.val - 1)
    Tracer.delay()
    # }

    # Create clone of the current node
    cloned_node = Node(node.val)
    cloned_map[node.val] = cloned_node

    # visualize {
    log_tracer.println(f'Cloned Node {node.val} into memory')
    clone_status[node.val - 1] = f'Node({node.val})'
    clone_map_tracer.patch(node.val - 1, clone_status[node.val - 1])
    Tracer.delay()
    clone_map_tracer.depatch(node.val - 1)
    # }

    # Iterate through all neighbors
    for neighbor in node.neighbors:
        # visualize {
        log_tracer.println(
            f'Inspecting edge: Node {node.val} -> Node {neighbor.val}'
        )
        graph_tracer.visit(neighbor.val - 1, node.val - 1)
        Tracer.delay()
        # }

        if neighbor.val not in cloned_map:
            cloned_neighbor = clone_graph(neighbor)
        else:
            # visualize {
            log_tracer.println(
                f'Neighbor {neighbor.val} already cloned, reusing reference'
            )
            Tracer.delay()
            # }
            cloned_neighbor = cloned_map[neighbor.val]

        # Link neighbors in the cloned graph
        cloned_node.neighbors.append(cloned_neighbor)

        # visualize {
        u, v = node.val - 1, neighbor.val - 1
        cloned_matrix[u][v] = 1
        clone_matrix_tracer.set(cloned_matrix)
        clone_matrix_tracer.select(u, v)
        log_tracer.println(
            f'Connected Cloned Node {node.val} -> Cloned Node {neighbor.val}'
        )
        Tracer.delay()
        clone_matrix_tracer.deselect(u, v)
        graph_tracer.leave(neighbor.val - 1, node.val - 1)
        # }

    # visualize {
    log_tracer.println(
        f'Finished cloning Node {node.val} and all its neighbors'
    )
    graph_tracer.leave(node.val - 1)
    Tracer.delay()
    # }

    return cloned_node


def main():
    # Construct original adjacency matrix for GraphTracer
    adj_matrix = [[0] * n for _ in range(n)]
    for i, neighbors in enumerate(adj_list_input):
        for nbr in neighbors:
            adj_matrix[i][nbr - 1] = 1

    # visualize {
    Layout.set_root(
        VerticalLayout([
            HorizontalLayout([graph_tracer, clone_matrix_tracer]),
            HorizontalLayout([clone_map_tracer, log_tracer]),
        ])
    )
    graph_tracer.set(adj_matrix)
    clone_matrix_tracer.set(cloned_matrix)
    clone_map_tracer.set(clone_status)
    log_tracer.println('Starting Clone Graph DFS...')
    Tracer.delay()
    # }

    original_head = build_graph(adj_list_input)
    cloned_head = clone_graph(original_head)

    # visualize {
    log_tracer.println(f'Cloning complete! Cloned head node: Node({cloned_head.val})')
    # }


main()
