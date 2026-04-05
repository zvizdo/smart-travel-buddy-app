# Context
We want to build another view to accompany the current map.
The current map view is location first, we get a good sense of the geography, but we don't get a good sense of the timeline.

# New Timeline View
The idea of the timeline view is that we would essentilly be able to show the same DAG as in the map view,
except organize it in a timeline view.
The timeline should be top to bottom, with top representing earlier times
We should distincly be able to see the dates on the left of the timeline and then the right much larger side should be the actual timeline.

We should clearly show all nodes and edges and clearly have each path in its idividual lane when it's separate, and merge paths when they merge.
Likewise if there are multiple starts to the trip we should show a DAG with 2 or more starting nodes.

It should all be organized in timeline orders. Nodes should be extended based on the arrival and departure times.
Similar to Google Calendar, longer meetings are shown larger, and shorter meetings are shown smaller.

All functionality from the map view should be available in the timeline view.
If I click on an edge I should be able to create a split node.
Click on the last node can createa a branch node.
Click on the node itself should have the same view shown as in the map view.

Largely we are talking about a different view of the same DAG, so there shouldn't be much to do if anything on the backend.
Discuss the way to execute this with the UX expert subanget and then talk to UI frontend engineer subagent to pin down the implementation.

If nodes arrival and departure time is not set, we need to show it in the middle of the nodes it is, or some distance from the previous node, however there should be a warning that the times have not been set.

If only arriaval time is set, we should show the node at the arrival time, and the departure time should be set to the arrival time + 1 hour.

If only departure time is set, we should show the node at the departure time, and the arrival time should be set to the departure time - 1 hour.

