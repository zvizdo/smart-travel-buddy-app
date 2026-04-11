# Context
We want to update the current way nodes timings are calculated. 
Currently each node has to have at least arrival time present.

Sometimes when planning we have clear nodes where we want to spend the night or where we have to be at a certain time. 
But between to "time solidifyed" nodes we might want to have some flexibility, so we can add some point of interest to the map,
those points of interest don't have a set arrial or departure time, but they should have duration time, how much time are we willing to spend there.
Arrival and departure can be estimated based on the travel time between the nodes and the duration of the point of interest.

# Goal
We want to make planning easier, and more flexible. 
We should be inferring as much as possible from nodes that do have time, and the routes between them,
but we don't need to force the user to have a time for every node. 

Discuss with the UX designer how to best represent this in the UI, and more importantly how to make that flow intuitive.

# Implementation details
- Start node should only have departure time, arrival time is not relevant. You **MUST** infer what a starting node is from the DAG (it has no incoming edges).
- End node should only have arrival time, departure time is not relevant. You **MUST** infer what an end node is from the DAG (it has no outgoing edges). We should mark end node markers as such, similar to how we do it with start nodes.
- Nodes can be without arrival or departure time. If it has no arrival and departure time, they should be inffered from the travel times between the nodes and the duration of the point of interest. 
    - Such "timeless" nodes should be shown different in the timeline view.
    - It's important to still show estimated times for those nodes, but they should be clearly marked as estimated.
    - Node should have a "duration" field, which is the time we are willing to spend there. This should be used to calculate the arrival and departure times of the node.
- When creating a new node, or editing it, you can remove arrival or departure time, if you do then you need to put in duration you are willing to spend there.
    - We should internally have 3 different types of nodes:
        - Time-bound nodes: Arrival time and departure time are set, duration is irrelevant even if set
        - Duration-bound nodes: Duration time is set, arrival and departure times are estimated based on the travel times between the nodes and the duration of the point of interest
        - Mixed-bound nodes: Arrival OR departure time is set, and duration is set. 
    - For backward compatibiity we can assume a default duration value of 30 minutes for existing nodes that don't have duration set. 

# UI changes
We want the timeline to be more zoom outable, so we can see more. Current dedault is fully zoomed in,
The defalt is okay, but we want to go more zoom out if needed.
The current default should be the maximum zoom out level, and we should be able to zoom out more if needed.
       