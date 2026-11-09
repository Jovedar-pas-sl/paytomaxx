/**
 * Logo de OxioPay para las páginas del cliente (/pay, /s, /w), que son
 * oscuras: el wordmark claro (crema con el punto lima). Va como data: URI
 * porque la CSP del API solo deja img-src 'self' data: y así la página no
 * pide nada más al cargar (el cliente puede tener mala red).
 *
 * Origen: oxiopay-wordmark-claro.png (4088 bytes, 256×51), hecho con las
 * letras del logo de «oxiocard» (np-handoff/herramientas/grafito/logo/componer.cjs).
 * Las letras ocupan 43 de las 51 filas; lo de abajo es el descendente de la «p»
 * y la «y». Usar la imagen, no imitarla con una fuente.
 */
export const OXIOPAY_WORDMARK = {
  src: [
    'data:image/png;base64,',
    'iVBORw0KGgoAAAANSUhEUgAAAQAAAAAzCAYAAAB469bRAAAPv0lEQVR4Ae3BsXMb94IY4E8Mi6dCQyyqWxThD11uxjPc0lW07y8w3F0qrrrXCTcunlMJ6k6F',
    '51Z/gaAqV0JdUr1V51QHzbhwhx8bbCrsckaF3NjhhcxQFAmQNEFSz8L3Pfjtt99sbHwOHjx4YONubbuhpo4dZI51kDlvitaRJA2VJX78aauDAh2n4tdf/Tq2',
    'sTY//rQVMMK+s15j+PVXv7Y2vgjbrqGpYwc5cmR47JqaOjpygCkmmCRpaH/8aStDhR2f+PGnrSHyr7/6tbWxDmM8dt4+AnIbX4RtV9DUMcMQ+9ZjF7v4BhPH',
    'RthxsT0UKG3cyI8/bQU8ttxjG1+MLSs0dew0dRzj37Fv/Q6SNLSOBatlNtYhuMSPP23lNr4I25Zo6phhgl23Jzq1Z7Vg4660Nr4IWy7Q1DFDhV1358BqUxvr',
    'EF3i669+ndr4Imz5RFPHDibYcfseOzW1WrRxY19/9WvEW8u9sfHF2HLeCLvuSFPHwrHScgcY21iXAq+ddYiXKGx8MbZ9pKljwFN3a4Tx11/9Wv3401YfBQIC',
    'pphi8vVXv7Y21uLrr36NKFDY+KJtO2vk7rVNHUOShvj1V79GjPwdaOqYOysmaYj+DjR1zNBx3jRJQ+t3auqYOysmaYiuaTGfBQTEbq8ffWQxn4Vurx99YjGf',
    'BQTHYrfXjzYute1EU8cOBu7WWwySNLRNHUeYJmmY+EhTx+BIkoboHjR1zFAgQ4YdSzR1dOItIiZJGiY+0dRxjH2r/TlJQ+UKmjrm+JvV3iRpGDhW4rHzDps6',
    'FkkaJlZo6pihQIYMO5Zo6ujEW0RMkjRMrFbgmSOL+cwFHjiymM8KDPCNTyzmM0feoULZ7fWjG1rMZzkK5Nh1c8+7vf7IicV89pvVnnR7/bErWMxnJZ5a7nm3',
    '1x9tO5Vjx9UdoEL0+1RJGiqnJqiaOg4xxQhDTFEgukNNHXOMsev6HuMx9ps6HmKUpKF0aogBdiw3buqYJWloXW5stUMULreDISYu0NQxxxi7ru8xHmO/qeMh',
    'RkkaSr/DYj7LMMae1fawh6eL+ew1Rt1eP7qmxXyWo8SeP5htp3JXc4hBkobKmjR1nGCCHBWyJA2Dpo45Iip3qKljiafWYwdFU8dxkobWkSQNbVPHIV5ZbhdD',
    'jKzQ1HGEXauNkjS0ruaxCzR1LPHUeuygaOo4TtLQur4KO65nH4PFfDbs9vpjV7SYz0Z45nZU7tmWU7mryZM0VNZrhBJDtI40dRxh6ljljjR1HOKp9TlAjkFT',
    'x8qJJA1jvLXas6aOwRJNHQOeWe1tkobSDTR1HOKp9XmHHIOmjpXr2/H77ODVYj4rXMFiPhvjmdtx2O31K/dsy6k9l3uXpGFqjZo6ZsiQI2CQpCFigBI5pk0d',
    'c7esqWPAyPocYoABXuFxU8fCqcLlxpYbu9zQDTR1DBhZn0MUGOAVHjd1LNytV4v5rLDCYj4bYt/tGfkMbDnS1DFzNVPr16JESNKQY9TUsUCODGWShgJTt2+I',
    'HetxiNyxV06NnEjSEPHcao+bOhY+0dSxwGOrPU/SMHUzQ+xYj0Pk6OCVUyN3r1zMZ8EFFvNZwL+6Pa+7vX7pM7DlWMfVRGuWpCEiR+XYCCUGyJE1dSySNLRu',
    '38B6HCB3rHLWblPH3IkkDSMcWG3kvJHVDlC6uYH1OEDu2MRZu00dM3drByMXG7kdB/i22+sXPhPbjgX3LzZ13MET5KgcSdKQOdLUMSRpiG5JU8eAXau9wdRq',
    'MUnD2JGmjhE7zstROVXgb5bbbepYJGkYO9LUscCu1YokDa0baOqYYddqbzC1WkzSMHakqWPEjvMGmLq+Q0wQHetggF2X21/MZ6Nurx+dWMxnAfuu5jWi1Z45',
    '9hKjbq/f+oxsOxbcrwEmKFFhiBxFU8cMFUqM3J7Mak+SNIxdUVPHArsulvtIkoaqqeNr7FtuiLFjQ6u9SdJQubnMat8maZi4oqaOBXZdLHd9bzHo9vqts4aL',
    '+WyIf3W5AUqnBi53iLzb609dYjGfPXPsKYrFfJZ3e/2pz8SWz8MYA2TIUSImaRhigCpJw8jtyqyQpGHsegaW6zhviEPL7TV1DE0dA/Ysd4jCegQrJGmYuJ6B',
    '9Xnd7fXzbq/fukC31y/xxOUGzhq43KDb609d3w6qxXyW+UxsuWdNHTPkyFGidGynqWOOCfKmjoXb1bFeHcvt+USShhaF1TIMrDZK0tBaj2C9OpZ77HpGLtHt',
    '9cd4Y7XMWZnVXnZ7/crvt4NqMZ8Fn4Et969FiQw5KuR4gAky5Mjcrsw9S9IwwVvLZehY7m2ShtL6BJ+n191eP7qakdV2nLVjtYmb28HIZ2DLPUvSEJGjdCRJ',
    'wwgFOshRIkvSMPRlKHBoucxyQ38MldXGrqjb609dYjGf5a5u6ooW81nHcvuL+Sy4Z1uuJ1qzpo4ZAnJExzqo0CJH2dQx8+XYsVzHcq0/hmi11v3puLrMapl7',
    'tuV6ovXrIHNs0tRxgiEmmCAiS9Iw9WUYW62y3NgfQLfXj3huiW6vP3VFi/ms43JTV5e7uoHVMvdsy/2LmGCIKVpMUWKKUZKG6O9Px3IHLtDUscBjy0W0lnvc',
    '1LHw+QqWe+esEodubuAS3V6/derAarkrWMxnHRSu58BquStYzGcdFK5gyz1L0hCTNEwxRY4hSkySNBRJGoZNHbOmjh23q7XcG9e3Z7noE00dOyitVqGyWtnU',
    'sWM9Wsu9cX27lmt9pNvrt8hx6HdazGcZSqu9c9bUavuL+axwuRI7rmdqtf3FfFa4XIkdV7DlWOUKkjRU1qyp46ipY4sKU1TooONIU8cxKgS3a2q5yjU0dRxa',
    'LTqvxI7lDpI0xCQNUxxYbgcj6zG13MQ1NHUcWm3qE91ef4och65pMZ91MMGO1SpnTVzu1WI+KyyxmM/G2Hd9E5d7tZjPCkss5rMx9l3RtmOty71xOypEVMhR',
    'IEfu2D76SRqi2zV1sbdJGkpHmjrmlgsIyPCN1SofaeqYY99qY6fGeGa5p00dJ0kaKjcTXextkoaxI00dc8sFBGT4xmpTF+j2+tPFfBYwwlNHFvPZyKmI6FQH',
    'OQrsuNzYWRO8crlXi/lsiAkiAjoYYNfvM8Erl3u1mM+GmCAioIMBdl3DtiNJGqZNHQ+xY7mJNWvqmGOCHENUSRo6jjR1HDR1jHiNEgO3q3LeIYqmjh1U2LMe',
    'lbNKqx2idKrEEDuWK5G5mcp5hyiaOnZQYc96VC6wmM9ylNhz6pn1eNvt9ac+0u3128V89hr7LreHPWvS7fXbxXz2Gvsut4c9N7TlVGW5d0kaxj7S1LHT1DF3',
    'pKljp6lj7hqaOk4RMESFzFk5KgwxcsuSNLR449QhcrSosGc93iZpiE40dRxhz2plkobWiSQNLUqr7TV1HLqBJA0Rb5w6RI4WFfasx5skDdEnFvNZib9hz+0Y',
    'udgQh+7HEIfuyJZTE8sVTjR1LJo6ThwrmzqOHcscaerYNnUcN3VsmzpmTR0HTR3bpo6hqWPW1HHU1HGAAqVjQ2TImzoWTR3LJA1DTFElaZi6G6Vjh8gRUWHP',
    '+oycaOoYMLTaQZKGkU8kaRjhwGqjpo7Bea2rKx07RI6ICnvWp/SJxXw2wFO352W3169coNvrtyjcg26v36JwR7acmuDQeU+SNEwdaepYYIKAEjlyhCQNpVMl',
    'hqgQkSdpiKgQMEaGHCVikoY8ScMUE+RNHcdJGgqM3ZEkDRX+GTkiKuxZn5dJGiqnSuxYrbBcYbUdlM6rXFGShgrPkSOiwp71eZmkoXJe6fa87vb6Qyt0e/0J',
    'nrgH3V5/gifuwJYTSRpalM56maRh7EhTxw6GKJEjwxQdxKaOVVPHDENUmGKKQZKGqWM7GCNHiYAsSUPV1HHc1PE3lMiRNXUcJ2ko3aEkDWWShikq7Fmf10ka',
    'hk40dRzgG6u9TtJQWSJJQ4XXVvumqePAWWMcuKIkDaMkDVNU2LM+r5M0DH1iMZ9l2HU7Xnd7/cIVdHv9MZ7g0B3r9vpjPMGhW7TlrBKHjr1O0jBs6pg1daww',
    'QI4MJXKM8V8dG6PCFEP8OzoomzqOmzpmeIK/IcMYgyQNsaljwAB9ZCiRu18jHLi5A3ybpKFwoqljB6XVDjF0uSEOrVY2dew4kaShReH6Rjhwcwf4NklD4WKZ',
    '9TvAt91ev3AN3V5/jAxvXc8hvnUD3V5/jAxvXc8hvnUF/2k0Gvn/Hj7qfPjwvv0ZvyRpKBz58L79Gf8T3yPie3yPNklD+eF9+99Q4ntE/Bv+BS/wP/AL/oR/',
    'w7/gf+MV/hF/+fC+/VOShvjhfftP+C/4J3yPNknDyD15+Kjz88NHnfLD+/YdfsED/IOreYs3eJGk4S8PH3V+9pEP79vv8Y3V/nuShsolHj7qfPjwvv0/GFiu',
    'g18ePupUTjx81Ikf3rev8QD/iD858fBR57kLPHzU+fnho0754X37Dr/gAf7B1bzFG7xI0vCXh486P/vE8+fP/Ye/fjccIHdzh/hfeNHt9YsXP7z82e/w4oeX',
    '7YsfXo7/+t3wDR4iQcfF3uEFim6vP/3rd8OR5d6++OFlZYUXP7xsX/zwcvzX74Zv8BAJOi72Di9QdHv96V+/G44s9/bFDy+rbZ9I0jDBxFlT5KjQIsd/buqY',
    'Y4wMFXLHBkkaRk0dCwyRO1YhR4JOkobY1LFt6jhEjgpjBLQ+A0kaJpj4SFPH3Hltkoapq5mgskKShsoVJWkYN3WMVmt9IklDxBDDpo4dZK4gScMEEyeaOnaQ',
    'Oa9N0jC1fv+MqeXabq8/tWbdXn+KwpHFfNZB5iPdXr9y3p8tF11Rt9efonBkMZ91kPlIt9evnPdny0VHHvz2228u0tRxiBZTVBgiR8QYU0THcpTIkjRkTR0D',
    'AqYokSHHACFJw6ip4xARERWGmGCMSZKGsY0vyoMHD/yHxXw2wjPL/bnb61c2llrMZyWeWu55t9cfbVsiSUPZ1DFHixyVYzkCWuQoUSHHoKljwBQtWuQoUSFP',
    '0tA2dSyRI2CIHJUjSRoGNjY27sSWFZI0VEkaYpKGaZKGDgLyJA0VKlQYOpYlaRg71iLDFBWGKJM0tI5lGCNHiYAMExsbG3dmy/VlTR1HSRoKTBHRwbSp4xAt',
    'KlQYokWRpGHc1HHQ1LHAEAVaZEkaJkkaYpKG1sbGxp3Zdg1JGloUTiRpKJo65ohJGtqmjo4MkzQUTR1LDFGhcmyKTpKGKTIbGxv/z2I++83deN3t9Qsnth88',
    'eOCGKqdKp4bOizY2Nu7LIYY+smVjY+NLUXR7/dZHtm1sbPyRHWLY7fXHLrBtY2Pjj+otim6vHy2xbWNj4+/NO+y52AEqlN1ef+oS2zY2Nj4HiSvq9vqtI4v5',
    'LHfWtNvrtzY2NjY2NjY2Vvq/L/gS1FDJCPwAAAAASUVORK5CYII=',
  ].join(''),
  width: 256,
  height: 51,
  /** Filas de las letras (sin el descendente): para que midan lo mismo que antes. */
  letterRows: 43,
} as const;
