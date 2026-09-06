# Week 2/7: Node-RED edge gateway with the baked-in flows file.
# The flows file implements FR1 (virtual sensors, 5 s smoothing, CO2>1000 local
# emergency fan) and FR4 (applies cloud setpoint commands to the actuators).
FROM nodered/node-red:4.0.9

COPY --chown=node:node edge/flows.json /data/flows.json

EXPOSE 1880
