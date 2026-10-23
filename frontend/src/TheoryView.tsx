// Theory tab: every equation the app computes, where it is used, and its source.
// HIM = Paul, Atiemo-Obeng & Kresta (eds.), Handbook of Industrial Mixing (Wiley, 2004);
// equation and page numbers checked against the 2004 edition (cite).
// Equations are TeX strings rendered with KaTeX (static content, so the HTML injection is safe).
import katex from "katex";
import "katex/dist/katex.min.css";

const T = String.raw;

function Tex({ src, block = true }: { src: string; block?: boolean }) {
  const html = katex.renderToString(src, { throwOnError: false, displayMode: block, output: "html" });
  return <div className={block ? "eq" : "eq inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Each equation appears once; vars lists every symbol as [TeX, meaning and unit].
type Eq = { name: string; eq: string[]; vars: [string, string][]; where: string; refs?: string[]; note?: string; cite?: string };
type Section = { id: string; title: string; intro?: string; items: Eq[] };

const REFS: Record<string, string> = {
  HIM: "E.L. Paul, V.A. Atiemo-Obeng, S.M. Kresta (eds.), Handbook of Industrial Mixing: Science and Practice, Wiley-Interscience, 2004.",
  "HIM-2": "HIM Ch. 2, Turbulence in mixing applications (Kresta & Brodkey), pp. 19-87.",
  "HIM-6": "HIM Ch. 6, Mechanically stirred vessels (Hemrajani & Tatterson), pp. 345-390.",
  "HIM-7": "HIM Ch. 7, Mixing in pipelines (Etchells & Meyer), pp. 391-477.",
  "HIM-9": "HIM Ch. 9, Blending of miscible liquids (Grenville & Nienow), pp. 507-542.",
  "HIM-10": "HIM Ch. 10, Solid-liquid mixing (Atiemo-Obeng, Penney & Armenante), from p. 543.",
  "HIM-12": "HIM Ch. 12, Immiscible liquid-liquid systems (Leng & Calabrese), pp. 639-753.",
  "HIM-14": "HIM Ch. 14, Heat transfer (Penney & Atiemo-Obeng), pp. 869-886.",
  SkellandSeksaria: "A.H.P. Skelland, R. Seksaria, Minimum impeller speeds for liquid-liquid dispersion in baffled vessels, Ind. Eng. Chem. Process Des. Dev. 17 (1978) 56-61.",
  ZhouKresta: "G. Zhou, S.M. Kresta, Impact of tank geometry on the maximum turbulence energy dissipation rate for impellers, AIChE J. 42 (1996) 2476-2490.",
  Hinze: "J.O. Hinze, Fundamentals of the hydrodynamic mechanism of splitting in dispersion processes, AIChE J. 1 (1955) 289-295.",
  Shinnar: "R. Shinnar, On the behaviour of liquid dispersions in mixing vessels, J. Fluid Mech. 10 (1961) 259-275.",
  Doulah: "M.S. Doulah, An effect of hold-up on drop sizes in liquid-liquid dispersions, Ind. Eng. Chem. Fundam. 14 (1975) 137-138.",
  ChenMiddleman: "H.T. Chen, S. Middleman, Drop size distribution in agitated liquid-liquid systems, AIChE J. 13 (1967) 989-995.",
  Calabrese: "R.V. Calabrese, T.P.K. Chang, P.T. Dang, Drop breakup in turbulent stirred-tank contactors. Part I, AIChE J. 32 (1986) 657-666.",
  Danckwerts: "P.V. Danckwerts, The definition and measurement of some characteristics of mixtures, Appl. Sci. Res. A3 (1952) 279-296.",
  Corrsin: "S. Corrsin, The isotropic turbulent mixer: Part II. Arbitrary Schmidt number, AIChE J. 10 (1964) 870-877.",
  HongLee: "P.O. Hong, J.M. Lee, Changes of the average drop sizes during the initial period of liquid-liquid dispersions in agitated vessels, Ind. Eng. Chem. Process Des. Dev. 24 (1985) 868-872.",
  Kolmogorov: "A.N. Kolmogorov, The local structure of turbulence in incompressible viscous fluid for very large Reynolds numbers, Dokl. Akad. Nauk SSSR 30 (1941) 301-305.",
  Rousseeuw: "P.J. Rousseeuw, Silhouettes: a graphical aid to the interpretation and validation of cluster analysis, J. Comput. Appl. Math. 20 (1987) 53-65.",
  CFL: "R. Courant, K. Friedrichs, H. Lewy, Uber die partiellen Differenzengleichungen der mathematischen Physik, Math. Ann. 100 (1928) 32-74.",
  LIC: "B. Cabral, L.C. Leedom, Imaging vector fields using line integral convolution, Proc. SIGGRAPH '93 (1993) 263-270.",
  Jobard: "B. Jobard, W. Lefer, Creating evenly-spaced streamlines of arbitrary density, Visualization in Scientific Computing '97, Springer (1997) 43-55.",
  FlyingEdges: "W. Schroeder, R. Maynard, B. Geveci, Flying edges: a high-performance scalable isocontouring algorithm, IEEE LDAV (2015) 33-40.",
  VTK: "VTK vtkStreamTracer (Runge-Kutta 4 integration), Kitware, https://vtk.org.",
  App: "Defined in this app / mstar_stats_summary.py (a numerical or reporting convention, no external source).",
};

const SECTIONS: Section[] = [
  {
    id: "steady", title: "Steady state and averaging",
    intro: "Steady-state means, standard deviations and min/max in the summaries are taken over t >= t_start.",
    items: [
      { name: "Plateau detection (windowed-mean drift)",
        eq: [T`\frac{|m_\mathrm{cur} - m_\mathrm{prev}|}{\max\left(|m_\mathrm{prev}|,\ \mathrm{tol}\,\max|y|\right)} < \mathrm{tol}`,
             T`m_\mathrm{cur} = \overline{y}\,\big|_{(t-w,\ t]},\qquad m_\mathrm{prev} = \overline{y}\,\big|_{(t-2w,\ t-w]}`,
             T`t_\mathrm{start} = t^{*} - w,\qquad t^{*}:\ \text{first } t \text{ from which the criterion holds to the end}`],
        vars: [[T`y`, "monitored trace: mean fluid velocity [m/s] for the flow; a(t) [1/m] and S(t) [m^3/m^3] for the kinetics"],
               [T`m_\mathrm{cur},\ m_\mathrm{prev}`, "means of y over the current and the previous window [unit of y]"],
               [T`w`, "detection window [s]"],
               [T`\mathrm{tol}`, "relative drift tolerance (dimensionless, default 0.02)"],
               [T`t^{*}`, "end of the first window from which the criterion holds to the end of the run [s]"],
               [T`t_\mathrm{start}`, "start of the steady-state averaging window [s]"]],
        where: "mstar_stats_summary.py detect_steady_start; Run > Steady state", refs: ["App"] },
      { name: "Fallback averaging window (no plateau)",
        eq: [T`t_\mathrm{start} = t_\mathrm{end} - \max\left(w,\ 0.25\,(t_\mathrm{end} - t_0)\right)`],
        vars: [[T`t_0,\ t_\mathrm{end}`, "first and last sample time [s]"], [T`w`, "detection window [s]"],
               [T`t_\mathrm{start}`, "start of the averaging window [s]"]],
        where: "fallback_start; rows labelled 'fallback (not steady)' or '(no plateau, last window)'", refs: ["App"] },
      { name: "Steady-state statistics",
        eq: [T`\bar y = \frac{1}{n}\sum_i y_i,\qquad s = \sqrt{\frac{\sum_i (y_i - \bar y)^2}{n - 1}},\qquad \mathrm{CoV} = \frac{s}{|\bar y|}`],
        vars: [[T`y_i`, "samples at t >= t_start"], [T`n`, "number of samples [count]"], [T`\bar y,\ s`, "mean and sample standard deviation [unit of y]"],
               [T`\mathrm{CoV}`, "coefficient of variation [unit of y / unit of y]"]],
        where: "stats_summary.csv, Plots > Steady from", refs: ["App"] },
      { name: "Cumulative time integral (trapezoidal rule)",
        eq: [T`I(t_i) = \sum_{j \le i} \tfrac12\,(y_j + y_{j-1})\,(t_j - t_{j-1})`],
        vars: [[T`y_j`, "sample of the integrated quantity at time t_j"], [T`t_j`, "sample time [s]"],
               [T`I(t_i)`, "integral from the first sample to t_i [unit of y s]"]],
        where: "int_a; heat-transfer energy integrals", refs: ["App"] },
    ],
  },
  {
    id: "flow", title: "Flow, power and numerics",
    items: [
      { name: "Power number",
        eq: [T`\mathrm{Po} = \frac{P}{\rho N^3 D^5}\quad[\mathrm{W/W}]`],
        vars: [[T`P`, "impeller power [W]"], [T`\rho`, "density [kg/m^3]"], [T`N`, "rotational speed [1/s]"],
               [T`D`, "impeller diameter [m]"]],
        where: "MovingBody_*.txt 'Power Number' (M-Star); power_metrics 'Power Number from Torque' (P from torque, rho = rho_c, D = input <diameter>)",
        refs: ["HIM-6"], cite: "HIM Sec. 6-2.3.2, p. 360",
        note: "M-Star's reference density/diameter may differ from rho_c and the input <diameter>, so the two values can differ." },
      { name: "Volume-mean energy dissipation rate",
        eq: [T`\bar\varepsilon = \frac{1}{V}\int_V \varepsilon\,dV\quad[\mathrm{W/kg}]`],
        vars: [[T`\varepsilon`, "local resolved dissipation rate [W/kg]"], [T`V`, "fluid volume [m^3]"],
               [T`\bar\varepsilon`, "volume mean (resolved) dissipation rate [W/kg]"]],
        where: "Fluid.txt 'Mean Energy Dissipation Rate'", refs: ["HIM-2"], cite: "HIM eq. (2-18), p. 55" },
      { name: "Courant number",
        eq: [T`\mathrm{Co} = \frac{u\,\Delta t}{\Delta x}\quad[\mathrm{m/m}]`],
        vars: [[T`u`, "velocity: input uMax or simulated maximum [m/s]"], [T`\Delta t`, "time step [s]"],
               [T`\Delta x`, "lattice spacing [m]"]],
        where: "*_settings.csv", refs: ["CFL"] },
      { name: "Lattice size", eq: [T`L_x = \mathrm{round}\left(\ell_x / \Delta x\right)\quad[\text{cells}]`],
        vars: [[T`\ell_x`, "domain length in x (input domainX, same for y, z) [m]"], [T`\Delta x`, "lattice spacing [m]"],
               [T`L_x`, "number of cells [count]"]],
        where: "*_settings.csv", refs: ["App"] },
      { name: "Tank geometry (from the domain)",
        eq: [T`T = \text{smaller horizontal domain extent}\ [\mathrm{m}],\qquad H = \frac{V_\mathrm{liq}}{\pi T^2 / 4}\ [\mathrm{m}],\qquad D/T\ [\mathrm{m/m}]`],
        vars: [[T`T`, "tank diameter (domain extent normal to the impeller axis) [m]"], [T`H`, "liquid height [m]"],
               [T`V_\mathrm{liq}`, "initial fluid volume [m^3]"], [T`D`, "impeller diameter [m]"]],
        where: "tank_geometry; *_settings.csv", refs: ["App"],
        note: "Assumes a cylindrical vessel filling the lattice domain horizontally; check against the drawing." },
      { name: "Impeller dimensionless groups (per impeller)",
        eq: [T`N = \frac{\mathrm{rpm}}{60}\ [\mathrm{1/s}],\qquad v_\mathrm{tip} = \pi N D\ [\mathrm{m/s}]`,
             T`\mathrm{Re} = \frac{N D^2}{\nu_c}\ [\mathrm{N/N}]\quad\text{(inertial / viscous forces)}`,
             T`\mathrm{Fr} = \frac{N^2 D}{g}\ [(\mathrm{m/s^2})/(\mathrm{m/s^2})]`,
             T`\mathrm{We} = \frac{\rho_c N^2 D^3}{\sigma}\ [\mathrm{N/N}]\quad\text{(inertial / interfacial forces)}`],
        vars: [[T`\mathrm{rpm}`, "impeller speed from input.xml <freq> [rev/min]"], [T`N`, "rotational speed [1/s]"],
               [T`D`, "impeller <diameter> from input.xml [m]"], [T`v_\mathrm{tip}`, "tip speed [m/s]"],
               [T`\nu_c`, "kinematic viscosity of the continuous phase (fluid with the larger initial volume) [m^2/s]"],
               [T`\rho_c`, "continuous-phase density [kg/m^3]"], [T`g`, "gravitational acceleration, 9.81 m/s^2"],
               [T`\sigma`, "surface (interfacial) tension [N/m]"]],
        where: "dimensionless_groups; *_settings.csv, Cases tab", refs: ["HIM-6", "HIM-12"],
        cite: "Re: HIM eq. (6-4), p. 358;  We: HIM eq. (12-22), p. 658-659" },
      { name: "Sauter diameter correlation (turbulent breakup, dilute to moderate holdup)",
        eq: [T`\frac{d_{32}}{D} = C_1\,(1 + C_3\,\phi)\,\mathrm{We}^{-0.6},\qquad C_1 = 0.053,\ C_3 = 3`],
        vars: [[T`d_{32}`, "Sauter mean diameter [m]"], [T`D`, "impeller diameter [m]"],
               [T`\phi`, "initial dispersed volume fraction [m^3/m^3]"], [T`\mathrm{We}`, "impeller Weber number [N/N]"],
               [T`C_1,\ C_3`, "empirical constants (dimensionless)"]],
        where: "dimensionless_groups ('d32 correlation'); *_settings.csv; compare with the CFD d32 and the voxel size", refs: ["ChenMiddleman", "Doulah", "HIM-12"],
        cite: "HIM eq. (12-30), p. 664 (C10 = 0.053, b = 3; Brown & Pitt data for phi < 0.3)",
        note: "For inviscid, noncoalescing dispersions; for coalescing systems HIM does not recommend eq. (12-30) (p. 664)." },
      { name: "Sauter diameter correlation, viscous drops",
        eq: [T`\mathrm{Vi} = \left(\frac{\rho_c}{\rho_d}\right)^{1/2}\frac{\mu_d N D}{\sigma}\ [\mathrm{N/N}]`,
             T`\frac{d_{32}}{D} = 0.053\,\mathrm{We}^{-0.6}\left(1 + 0.92\,\mathrm{Vi}^{0.84}\right)^{0.6}`],
        vars: [[T`\mathrm{Vi}`, "viscosity group [N/N]"], [T`\rho_c,\ \rho_d`, "continuous and dispersed-phase density [kg/m^3]"],
               [T`\mu_d`, "dispersed-phase dynamic viscosity [Pa s]"], [T`N`, "rotational speed [1/s]"],
               [T`D`, "impeller diameter [m]"], [T`\sigma`, "interfacial tension [N/m]"],
               [T`d_{32}`, "Sauter mean diameter [m]"], [T`\mathrm{We}`, "impeller Weber number [N/N]"]],
        note: "Dilute dispersions, mu_d <= 0.5 Pa s, Rushton turbine.",
        where: "dimensionless_groups ('d32 correlation, viscous drops'); *_settings.csv", refs: ["Calabrese", "HIM-12"],
        cite: "HIM eqs. (12-26) and (12-28), p. 661 (C7 = 0.054, C8 = 4.42 for eq. 12-26)" },
    ],
  },
  {
    id: "blend", title: "Scalar blending",
    items: [
      { name: "Mixing time from the tracer RSD",
        eq: [T`\mathrm{RSD}(t) = \frac{\sigma_c(t)}{\bar c(t)} \times 100\quad[\%]`,
             T`t_\mathrm{mix} = t\left(\mathrm{RSD}\ \text{last crosses below}\ X\,\%\right) - t_\mathrm{inj};\qquad X = 5\,\% \Rightarrow 95\,\%\ \text{mixing time}`],
        vars: [[T`\sigma_c,\ \bar c`, "standard deviation and mean of the tracer concentration over the fluid [unit of c]"],
               [T`X`, "RSD threshold [%] (Run > Mixing RSD threshold)"],
               [T`t_\mathrm{inj}`, "tracer injection time: end of the initial zero-concentration period [s]"],
               [T`t_\mathrm{mix}`, "mixing time [s]"]],
        where: "mixing_time_from_rsd, injection_start", refs: ["HIM-7", "HIM-9"],
        cite: "CoV: HIM Sec. 7-5.1.1, p. 411;  95 % homogeneity and eq. (9-18) for other levels: HIM p. 509, 514" },
    ],
  },
  {
    id: "disp", title: "Liquid-liquid dispersion: interface",
    intro: "From the M-Star interface Stats (A_int) and the fluid volumes; time series in dispersion_timeseries.csv.",
    items: [
      { name: "Specific interfacial area",
        eq: [T`a = \frac{A_\mathrm{int}}{V_\mathrm{liq}}\quad[\mathrm{1/m}]`],
        vars: [[T`A_\mathrm{int}`, "total interface area (M-Star interface Stats) [m^2]"],
               [T`V_\mathrm{liq}`, "liquid volume, all phases [m^3]"], [T`a`, "specific interfacial area [1/m]"]],
        where: "interface_metrics", refs: ["HIM-12"],
        cite: "a_v = interfacial area per unit volume of the mixed phases: HIM Sec. 12-1.3.2, p. 643" },
      { name: "Area-based Sauter diameter",
        eq: [T`d_{32} = \frac{6\,\phi}{a}\quad[\mathrm{m}]`],
        vars: [[T`\phi`, "dispersed-phase volume fraction [m^3/m^3]"], [T`a`, "specific interfacial area [1/m]"],
               [T`d_{32}`, "Sauter mean diameter [m]"]],
        note: "Only reported when closed drops carry most of the interface (coverage >= 0.5).",
        where: "interface_metrics", refs: ["HIM-12", "HIM-6"],
        cite: "HIM eq. (12-2), p. 643; gas-liquid form a = 6 phi / d32: HIM p. 382" },
      { name: "Interface enhancement",
        eq: [T`E(t) = \frac{a(t)}{a_0},\qquad E = \frac{a_\mathrm{ss}}{a_0}\quad[(\mathrm{1/m})/(\mathrm{1/m})]`,
             T`\text{flat-interface check: } a_0 \approx \frac{\pi T^2 / 4}{V_\mathrm{liq}}`],
        vars: [[T`a(t)`, "specific interfacial area at time t [1/m]"], [T`a_0`, "a at impeller start (flat interface, first sample) [1/m]"],
               [T`a_\mathrm{ss}`, "mean of a(t) over its plateau, or over the last window without a plateau [1/m]"],
               [T`T`, "tank diameter [m]"], [T`V_\mathrm{liq}`, "liquid volume [m^3]"]],
        where: "dispersion_kinetics, dispersion_timeseries.csv", refs: ["App", "HIM-12"],
        note: "App convention (no handbook equivalent): a_v of HIM eq. (12-2) normalised by its value before agitation, i.e. the factor by which mixing multiplied the area available for interphase transfer (rates scale with k a_v, HIM p. 644)." },
      { name: "Dispersion kinetics (first-order approach)",
        eq: [T`f(t) = \frac{a(t) - a_0}{a_\mathrm{ss} - a_0}\quad[(\mathrm{1/m})/(\mathrm{1/m})]`,
             T`t_{90},\ t_{95}:\ \text{first } t \text{ with } f \ge 0.90,\ 0.95\ \text{(linear interpolation)}`,
             T`\ln(1 - f) = -\frac{t}{\tau}\quad\text{(least squares over } 0.05 < f < 0.95\text{)}`,
             T`\text{first order: } t_z = -\tau\ln(1 - z):\qquad t_{90} = 2.30\,\tau,\quad t_{95} = 3.00\,\tau`,
             T`\mathrm{int}_a(t) = \int_0^t a\,dt\quad[\mathrm{s/m}]`],
        vars: [[T`f(t)`, "normalised approach, a_norm [(1/m)/(1/m)]"], [T`a(t),\ a_0,\ a_\mathrm{ss}`, "as in the interface enhancement [1/m]"],
               [T`t_{90},\ t_{95}`, "dispersion times [s]"], [T`\tau`, "time constant of the fitted first-order approach [s]"],
               [T`z`, "approach level (0.90, 0.95)"], [T`\mathrm{int}_a`, "time-integrated specific interfacial area [s/m]"]],
        where: "approach_kinetics, dispersion_kinetics", refs: ["HIM-9", "HIM-2", "HIM-12", "Corrsin", "HongLee", "App"],
        cite: "first-order decay and the 95 % criterion: HIM eqs. (9-14) to (9-18), p. 514;  I_s = exp(-t/tau): HIM eq. (2-14), p. 52;  first-order relaxation of d32 (alpha2 = 1, Hong & Lee 1985): HIM eq. (12-32), p. 676",
        note: "The handbook applies the first-order form to concentration fluctuations (blending) and to d32; the app applies it to a(t) and S(t). t95 / tau far from 3 means the approach is not first order. int_a (cumulative interface exposure) is an app convention." },
      { name: "Hinze maximum stable drop size (holdup and local-dissipation corrections)",
        eq: [T`d_\mathrm{max} = C\,(1 + k_\phi\,\phi)\left(\frac{\sigma}{\rho_c}\right)^{0.6}(\varepsilon_r\,\varepsilon)^{-0.4}\quad[\mathrm{m}],\qquad C = 0.725`,
             T`d_\mathrm{max}/\Delta x\quad[\mathrm{m/m}]\quad\text{(below 5 voxels the drop sizes are grid-limited)}`,
             T`\text{at the impeller: } \varepsilon_r\,\varepsilon = \varepsilon_\mathrm{max},\ k_\phi = 0`],
        vars: [[T`d_\mathrm{max}`, "maximum stable drop diameter [m]"], [T`C`, "Hinze constant (dimensionless)"],
               [T`k_\phi`, "holdup correction factor (Doulah: about 3; default 0)"], [T`\phi`, "dispersed volume fraction [m^3/m^3]"],
               [T`\sigma`, "interfacial tension [N/m]"], [T`\rho_c`, "continuous-phase density [kg/m^3]"],
               [T`\varepsilon`, "dissipation rate: eps(t) from Fluid.txt or --eps-file [W/kg]"],
               [T`\varepsilon_r`, "local / mean dissipation ratio (default 1)"],
               [T`\varepsilon_\mathrm{max}`, "maximum dissipation estimate, see Impeller power [W/kg]"],
               [T`\Delta x`, "lattice spacing [m]"]],
        where: "hinze_dmax, resolution_check, dispersion_timeseries.csv (eps(t)); power_metrics (at eps_max)",
        refs: ["Hinze", "Shinnar", "Doulah", "HIM-12"],
        cite: "HIM eqs. (12-14) to (12-21), pp. 657-658 (C1 empirical; the app uses Hinze's 0.725); holdup factor: HIM p. 664" },
    ],
  },
  {
    id: "drops", title: "Liquid-liquid dispersion: drop statistics (VOF surface)",
    intro: "Closed VOF surfaces are drops; open surfaces (bulk phases, wall-attached) and drops smaller than max(min voxels, min d/dx) are excluded.",
    items: [
      { name: "Drop volume, area and equivalent diameter",
        eq: [T`V = \tfrac16\sum_\triangle (\mathbf p_0 \times \mathbf p_1)\cdot\mathbf p_2,\qquad A = \sum_\triangle \tfrac12\left|(\mathbf p_1 - \mathbf p_0)\times(\mathbf p_2 - \mathbf p_0)\right|`,
             T`d_\mathrm{eq} = \left(\frac{6V}{\pi}\right)^{1/3}\quad[\mathrm{m}]`],
        vars: [[T`\mathbf p_0,\ \mathbf p_1,\ \mathbf p_2`, "vertex positions of each surface triangle of a closed drop [m]"],
               [T`V,\ A`, "drop volume [m^3] and surface area [m^2]"], [T`d_\mathrm{eq}`, "volume-equivalent sphere diameter [m]"]],
        where: "analyze_vof_surface", refs: ["App"] },
      { name: "Mean diameters",
        eq: [T`d_{32} = \frac{\sum d^3}{\sum d^2} = \frac{6\sum V}{\sum A}\quad[\mathrm{m}]`,
             T`d_{10} = \frac{\sum d}{n},\qquad d_{43} = \frac{\sum d^4}{\sum d^3},\qquad d_\mathrm{max} = \max d\quad[\mathrm{m}];\qquad d_{32}/\Delta x\quad[\mathrm{m/m}]`],
        vars: [[T`d`, "equivalent diameter of each drop of one fluid in one frame [m]"], [T`V,\ A`, "drop volume [m^3] and area [m^2]"],
               [T`n`, "number of drops [count]"], [T`\Delta x`, "lattice spacing [m]"]],
        where: "vof_structures (per fluid)", refs: ["HIM-12"],
        cite: "HIM eqs. (12-1), (12-3), (12-4), p. 643",
        note: "HIM uses d10 both for the number mean (eq. 12-4) and for the 10 % volume percentile; here d10 is the number mean." },
      { name: "Drop size distribution shape",
        eq: [T`d_\mathrm{max}/d_{32}\quad[\mathrm{m/m}]\quad\text{(per frame)}`,
             T`X = d/d_{32};\qquad \bar X,\ \sigma_V:\ \text{volume-weighted mean and std of } X \text{ over the steady frames}\quad[\mathrm{m/m}]`,
             T`\text{turbulent stirred tanks: } P_V(X)\ \text{normal},\quad \bar X = 1.07,\quad \sigma_V = 0.23\text{--}0.24`],
        vars: [[T`d,\ d_\mathrm{max},\ d_{32}`, "drop diameter, largest drop and Sauter diameter [m]"],
               [T`X`, "normalised drop size [m/m]"], [T`\bar X,\ \sigma_V`, "volume-weighted mean and standard deviation of X [m/m]"],
               [T`P_V(X)`, "volume probability density of X"]],
        where: "vof_structures (dmax_d32), dsd_shape", refs: ["ChenMiddleman", "HIM-12", "HIM-7"],
        cite: "HIM eq. (12-29), pp. 662-663; transient DSDs collapse the same way (sigma_V = 0.27): HIM p. 677;  d32 ~ 0.65 d_max: HIM p. 447; d32-d_max relation eq. (12-11), p. 645" },
      { name: "Dispersed fraction and interface coverage",
        eq: [T`F_{\mathrm{disp},k} = \frac{V_{\mathrm{drops},k}}{V_k}\quad[\mathrm{m^3/m^3}]`,
             T`\text{coverage} = \frac{A_\mathrm{drops}}{A_\mathrm{int}}\quad[\mathrm{m^2/m^2}]`],
        vars: [[T`V_{\mathrm{drops},k}`, "volume of the resolved closed drops of fluid k [m^3]"],
               [T`V_k`, "total volume of fluid k [m^3]"], [T`F_{\mathrm{disp},k}`, "fraction of fluid k dispersed as drops [m^3/m^3]"],
               [T`A_\mathrm{drops}`, "surface area of the resolved drops [m^2]"], [T`A_\mathrm{int}`, "total interface area [m^2]"]],
        where: "vof_structures", refs: ["App", "HIM-12"],
        cite: "related criterion: minimum speed N_min to disperse two settled layers (F_disp -> 1, no free layer left): HIM Sec. 12-6.2, p. 711",
        note: "App convention: experiments cannot separate drops from bulk liquid, so the handbook has no fraction-dispersed metric; the CFD surface topology can." },
    ],
  },
  {
    id: "uni", title: "Phase uniformity",
    intro: "The phase fraction is averaged over NZ axial x NR radial zones (Zone scales) of the fluid cells.",
    items: [
      { name: "Zonal coefficient of variation",
        eq: [T`\mathrm{CoV} = \frac{\sqrt{\sum_z w_z\,(\phi_z - \bar\phi)^2}}{\bar\phi}\quad[\mathrm{m^3/m^3}]`,
             T`w_z = \frac{V_z}{\sum V_z},\qquad \bar\phi = \sum_z w_z\,\phi_z`],
        vars: [[T`\phi_z`, "mean phase fraction of zone z (NZ axial x NR radial zones) [m^3/m^3]"],
               [T`V_z,\ w_z`, "fluid volume [m^3] and volume weight of zone z"], [T`\bar\phi`, "volume-weighted mean phase fraction [m^3/m^3]"]],
        where: "phase_uniformity (cov_*)", refs: ["HIM-7", "HIM-9", "HIM-10", "App"],
        cite: "CoV definition: HIM Sec. 7-5.1.1, p. 411;  CoV ~ 0.05 ('95 % uniformity') adequate for most suspensions: HIM p. 557" },
      { name: "Segregation index (intensity of segregation)",
        eq: [T`S = \frac{\sigma_z(\phi)}{\sqrt{\bar\phi\,(1 - \bar\phi)}} = I^{1/2}\quad[\mathrm{m^3/m^3}];\qquad 0\ \text{homogeneous},\ 1\ \text{fully segregated}`],
        vars: [[T`\sigma_z(\phi)`, "volume-weighted standard deviation of the zone phase fractions [m^3/m^3]"],
               [T`\bar\phi`, "volume-weighted mean phase fraction [m^3/m^3]"],
               [T`I`, "Danckwerts' intensity of segregation, sigma^2 / (phi_bar (1 - phi_bar))"], [T`S`, "segregation index [m^3/m^3]"]],
        where: "phase_uniformity (S_*)", refs: ["Danckwerts", "HIM-2"],
        cite: "intensity of segregation: HIM pp. 22-23; I_s = c'^2 / c0^2 (variance form, Fig. 2-14): HIM p. 54" },
      { name: "Homogeneity time",
        eq: [T`t_S = t_{95}\ \text{of the approach of } S(t) \text{ to its plateau (as for the dispersion kinetics)}`],
        vars: [[T`S(t)`, "segregation index per Volume frame [m^3/m^3]"], [T`t_S`, "homogeneity time [s]"]],
        where: "phase_uniformity", refs: ["HIM-9", "HIM-2", "App"],
        cite: "95 % homogeneity: HIM p. 514; first-order decay of I_s: HIM eq. (2-14), p. 52" },
      { name: "Phase continuity",
        eq: [T`\mathrm{share}_k = \frac{V\left(\text{largest connected region of } \phi_k > 0.5\right)}{V(\phi_k > 0.5)}\quad[\mathrm{m^3/m^3}]`,
             T`\text{continuous phase: } \mathrm{share}_k > \text{threshold (default 0.9); both above: stratified or co-continuous}`],
        vars: [[T`\phi_k`, "cell volume fraction of fluid k [m^3/m^3]"], [T`V(\cdot)`, "volume of the cells in the set [m^3]"],
               [T`\mathrm{share}_k`, "largest-region share of fluid k [m^3/m^3]"]],
        where: "region_shares (scipy.ndimage.label), phase_continuity.csv", refs: ["HIM-12", "App"],
        cite: "phase inversion and ambivalent region: HIM Sec. 12-5.4, pp. 707-709 (Fig. 12-23)",
        note: "A change of the continuous phase over time indicates phase inversion." },
      { name: "Holdup profile", eq: [T`\phi(z, t) = \overline{\phi}\ \text{over the fluid cells of layer } z`],
        vars: [[T`z`, "height of a one-cell layer along the vertical axis [m]"], [T`\phi`, "phase fraction [m^3/m^3]"]],
        where: "holdup_profile.csv", refs: ["App"] },
      { name: "Fluid-region center (Viewer center planes)",
        eq: [T`\text{fluid cells: } \textstyle\sum_k \phi_k \ge 0.5;\qquad \text{center} = \tfrac12\,(\min + \max)\ \text{of their coordinates}`],
        vars: [[T`\phi_k`, "cell volume fraction of fluid k [m^3/m^3]"]],
        where: "vtkio.fluid_bounds", refs: ["App"] },
    ],
  },
  {
    id: "zoner", title: "Zoning and heterogeneity (cfd_zoner)",
    items: [
      { name: "Value-based zones",
        eq: [T`x = \log_B \max(v, v_\mathrm{floor});\quad k\text{-means on } x\ \text{(or fixed log bins); zones split into connected sub-zones}`,
             T`s_i = \frac{b_i - a_i}{\max(a_i, b_i)};\qquad \text{number of zones} = \arg\max\,\bar s`],
        vars: [[T`v`, "cell value of the zoning variable"], [T`v_\mathrm{floor}`, "lower clip before the logarithm"],
               [T`B`, "logarithm base"], [T`x`, "clustered value"],
               [T`a_i,\ b_i`, "mean distance of cell i to its own cluster and to the nearest other cluster"],
               [T`s_i,\ \bar s`, "silhouette of cell i and its mean over the cells (-1 to 1)"]],
        where: "cfd_zoner.py cluster_values, bin_values", refs: ["Rousseeuw"] },
      { name: "Heterogeneity metrics",
        eq: [T`\mathrm{CV} = \frac{\sigma}{\mu},\quad \sigma_{\log} = \mathrm{std}(\log_{10} v),\quad P_{95}/P_{50},\quad P_{99}/\mu`,
             T`\eta^2 = \frac{SS_\mathrm{between}}{SS_\mathrm{total}},\qquad SS_\mathrm{between} = \sum_c n_c\,(\mu_c - \mu)^2`,
             T`\text{contrast} = \frac{\max \bar v_\mathrm{zone}}{\min \bar v_\mathrm{zone}},\qquad \text{gradient index} = \frac{\overline{|\nabla v|}\,L}{\mu}`],
        vars: [[T`v`, "cell value"], [T`\mu,\ \sigma`, "mean and standard deviation of v over the fluid cells"],
               [T`P_q`, "q-th percentile of v"], [T`n_c,\ \mu_c`, "number of cells [count] and mean of v in cluster c"],
               [T`SS_\mathrm{total}`, "total sum of squares of v about mu"], [T`\eta^2`, "share of the variance explained by the zones"],
               [T`\bar v_\mathrm{zone}`, "mean of v in a zone"], [T`|\nabla v|`, "magnitude of the gradient of v [unit of v / m]"],
               [T`L`, "characteristic domain length [m]"]],
        where: "cfd_zoner.py heterogeneity_stats", refs: ["HIM-2", "App"] },
    ],
  },
  {
    id: "heat", title: "Heat transfer (calc_ua)",
    items: [
      { name: "Wall-flux UA",
        eq: [T`UA(t) = \frac{Q_\mathrm{wall}(t)}{T_\mathrm{wall} - T_\mathrm{bulk}(t)}\quad[\mathrm{W/K}],\qquad U = \frac{UA}{A_\mathrm{wet}}\quad[\mathrm{W/(m^2\,K)}]`,
             T`UA_\mathrm{ls} = \frac{\sum Q_\mathrm{wall}\,\Delta T}{\sum \Delta T^2}`],
        vars: [[T`Q_\mathrm{wall}`, "heat flow through the wall [W]"], [T`T_\mathrm{wall},\ T_\mathrm{bulk}`, "wall and bulk fluid temperature [K]"],
               [T`\Delta T`, "T_wall - T_bulk [K]"], [T`A_\mathrm{wet}`, "wetted heat-transfer area [m^2]"],
               [T`U,\ UA`, "overall heat-transfer coefficient [W/(m^2 K)] and its product with the area [W/K]"],
               [T`UA_\mathrm{ls}`, "least-squares UA over all samples [W/K]"]],
        where: "calc_ua.py flux_ua", refs: ["HIM-14"], cite: "Q = U A dT: HIM eq. (14-1), p. 870" },
      { name: "Lumped energy balance",
        eq: [T`m c_p \frac{dT}{dt} = UA\,(T_\mathrm{wall} - T) + Q_\mathrm{diss}`,
             T`m c_p\,(T - T_0) - \int Q_\mathrm{diss}\,dt = UA \int (T_\mathrm{wall} - T)\,dt\quad\text{(least squares through the origin)}`,
             T`T(t) = T_\infty + (T_0 - T_\infty)\,e^{-UA\,(t - t_0)/(m c_p)},\qquad T_\infty = T_\mathrm{wall} + \frac{Q_\mathrm{diss}}{UA}`],
        vars: [[T`m,\ c_p`, "fluid mass [kg] and specific heat [J/(kg K)]"], [T`T,\ T_0`, "bulk temperature and its value at t_0 [K]"],
               [T`T_\mathrm{wall}`, "wall temperature [K]"], [T`Q_\mathrm{diss}`, "viscous heating (dissipated power) [W]"],
               [T`UA`, "heat-transfer coefficient times area [W/K]"], [T`T_\infty`, "steady temperature [K]"]],
        where: "calc_ua.py energy_ua", refs: ["HIM-14"] },
      { name: "Film coefficient (M-Star boundary condition)",
        eq: [T`h = C\,c_p\,\rho\,(\varepsilon\,\nu)^{a}\,\mathrm{Pr}^{b},\qquad \mathrm{Pr} = \frac{\nu}{\alpha}`],
        vars: [[T`h`, "wall film coefficient [W/(m^2 K)]"], [T`C,\ a,\ b`, "constants of the M-Star boundary condition"],
               [T`c_p,\ \rho`, "specific heat [J/(kg K)] and density [kg/m^3]"], [T`\varepsilon`, "local dissipation rate [W/kg]"],
               [T`\nu,\ \alpha`, "kinematic viscosity and thermal diffusivity [m^2/s]"], [T`\mathrm{Pr}`, "Prandtl number [(m^2/s)/(m^2/s)]"]],
        where: "parsed from input.xml", refs: ["HIM-14"],
        cite: "general form Nu = K Re^a Pr^b ...: HIM eq. (14-3), p. 878" },
    ],
  },
  {
    id: "power", title: "Impeller power and dissipation scales",
    intro: "From the steady means of the MovingBody torque and the case settings (rows with file 'derived' in stats_summary.csv).",
    items: [
      { name: "Impeller power from torque",
        eq: [T`P(t) = \left|\boldsymbol\Gamma(t)\cdot\hat{\mathbf a}\right|\,|\omega(t)|\quad[\mathrm{W}]`],
        vars: [[T`\boldsymbol\Gamma`, "torque vector on the impeller (MovingBody_<impeller>.txt) [N m]"],
               [T`\hat{\mathbf a}`, "unit rotation axis from input.xml"], [T`\omega`, "angular speed [rad/s]"],
               [T`P`, "impeller power (steady mean used below) [W]"]],
        note: "Also gives the power number from torque (see Power number).",
        where: "power_metrics", refs: ["HIM-6"] },
      { name: "Power per volume and power-based mean dissipation",
        eq: [T`P/V = \frac{\sum P}{V_\mathrm{liq}}\quad[\mathrm{W/m^3}]`,
             T`\varepsilon_P = \frac{\sum P}{M},\qquad M = \sum_k \rho_k V_k\quad[\mathrm{W/kg}]`,
             T`\text{resolved / power-based dissipation} = \bar\varepsilon_\mathrm{resolved} / \varepsilon_P\quad[(\mathrm{W/kg})/(\mathrm{W/kg})]`],
        vars: [[T`\sum P`, "power of all impellers [W]"], [T`V_\mathrm{liq}`, "initial fluid volume [m^3]"],
               [T`\rho_k,\ V_k`, "density [kg/m^3] and initial volume [m^3] of fluid k"], [T`M`, "fluid mass [kg]"],
               [T`\varepsilon_P`, "power-based mean dissipation [W/kg]"],
               [T`\bar\varepsilon_\mathrm{resolved}`, "volume-mean resolved dissipation from Fluid.txt [W/kg]"]],
        where: "power_metrics", refs: ["HIM-2"], cite: "HIM eq. (2-18), p. 55",
        note: "A ratio well below 1 means part of the impeller power is dissipated below the grid scale (subgrid model)." },
      { name: "Maximum dissipation estimate (power per impeller swept volume)",
        eq: [T`\varepsilon_\mathrm{max} \sim \frac{P}{\rho_c D^3} = \mathrm{Po}\,N^3 D^2\quad[\mathrm{W/kg}]`],
        vars: [[T`P`, "impeller power [W]"], [T`\rho_c`, "continuous-phase density [kg/m^3]"], [T`D`, "impeller diameter [m]"],
               [T`\mathrm{Po},\ N`, "power number [W/W] and rotational speed [1/s]"]],
        where: "power_metrics", refs: ["HIM-2", "ZhouKresta"],
        cite: "HIM eq. (2-19), p. 55; Fig. 2-15, p. 56 (within a factor of about 2 for four impellers)" },
      { name: "Kolmogorov length scale",
        eq: [T`\eta = \left(\frac{\nu^3}{\varepsilon}\right)^{1/4}\quad[\mathrm{m}];\qquad \eta/\Delta x\quad[\mathrm{m/m}]`],
        vars: [[T`\nu`, "kinematic viscosity (power_metrics: continuous phase nu_c) [m^2/s]"],
               [T`\varepsilon`, "dissipation rate: mean resolved and eps_max (power_metrics) or the local cell value (zoner) [W/kg]"],
               [T`\Delta x`, "lattice spacing [m]"]],
        where: "power_metrics; cfd_zoner variable 'kolmogorov'", refs: ["Kolmogorov", "HIM-2", "HIM-12"],
        cite: "HIM eq. (12-15), p. 657; micromixing scales: HIM p. 24",
        note: "The Hinze/Weber scaling holds for eta << d << L_T (inertial subrange), HIM p. 664." },
      { name: "Blend time correlation (turbulent)",
        eq: [T`\mathrm{Po}^{1/3}\,N\,t_{95}\left(\frac{D}{T}\right)^{2}\left(\frac{T}{H}\right)^{0.5} = 5.20\quad(\pm 10\,\%\ \text{std. dev. of the constant})`,
             T`\text{valid for } \mathrm{Po}^{1/3}\,\mathrm{Re} > 6370`],
        vars: [[T`t_{95}`, "95 % blend time [s]"], [T`\mathrm{Po},\ \mathrm{Re}`, "power number [W/W] and Reynolds number [N/N]"],
               [T`N,\ D`, "rotational speed [1/s] and impeller diameter [m]"], [T`T,\ H`, "tank diameter and liquid height [m] (see Tank geometry)"]],
        where: "power_metrics ('Blend Time t95 Correlation'); compare with the RSD mixing time", refs: ["HIM-9"],
        cite: "HIM eqs. (9-1) and (9-2), p. 509; turbulent limit p. 510" },
    ],
  },
  {
    id: "viz", title: "Visualization (Viewer)",
    items: [
      { name: "2D streamlines",
        eq: [T`\frac{d\mathbf x}{ds} = \frac{\mathbf u}{|\mathbf u|}\quad\text{(in-plane components, bilinear interpolation, RK2, evenly spaced seeds)}`],
        vars: [[T`\mathbf x`, "position on the plane [m]"], [T`s`, "arc length along the streamline [m]"],
               [T`\mathbf u`, "in-plane velocity components [m/s]"]],
        where: "flow.ts traceStreamlines", refs: ["Jobard"] },
      { name: "3D streamlines", eq: [T`\frac{d\mathbf x}{ds} = \mathbf u(\mathbf x)\quad\text{(RK4, seeded on the slice plane)}`],
        vars: [[T`\mathbf x`, "position [m]"], [T`s`, "integration parameter"], [T`\mathbf u`, "velocity vector field [m/s]"]],
        where: "vtkio.streamlines", refs: ["VTK"] },
      { name: "Line integral convolution",
        eq: [T`I(\mathbf x) = \frac{1}{2L + 1}\sum_{s=-L}^{L} N\left(\boldsymbol\sigma_{\mathbf x}(s)\right)`],
        vars: [[T`I(\mathbf x)`, "LIC intensity of pixel x"], [T`N`, "white-noise texture"],
               [T`\boldsymbol\sigma_{\mathbf x}(s)`, "streamline through x, sampled at step s [pixels]"], [T`L`, "kernel half-length [pixels]"]],
        where: "flow.ts lic", refs: ["LIC"] },
      { name: "Isosurfaces", eq: [T`\{\mathbf x : v(\mathbf x) = \text{level}\}\quad\text{(flying edges)}`],
        vars: [[T`v`, "scalar field"], [T`\text{level}`, "isovalue [unit of v]"]],
        where: "vtkio.isosurface_stl", refs: ["FlyingEdges"] },
    ],
  },
];

// Handbook metrics not computed yet (roadmap, in priority order)
const GAPS: { metric: string; eq: string; why: string; ref: string }[] = [
  { metric: "Minimum speed for liquid-liquid dispersion",
    eq: T`\frac{N_\mathrm{min} D^{0.5}}{g^{0.5}} = C_{20}\left(\frac{T}{D}\right)^{a_5}\left(\frac{\mu_c}{\mu_d}\right)^{1/9}\left(\frac{\Delta\rho}{\rho_c}\right)^{0.25}\left(\frac{\sigma}{D^2 \rho_c g}\right)^{0.3}`,
    why: "Design criterion for forming the dispersion (C20, a5 from Table 12-5); needs impeller type and clearance per case",
    ref: "HIM eq. (12-57), p. 711, Table 12-5, p. 712 (recommended, p. 713)" },
  { metric: "Phase-inversion regime map", eq: T`\text{continuous phase vs } \phi \text{ and } N \text{ across cases; ambivalent region}`,
    why: "Which phase is continuous and the risk of inversion; needs a speed or holdup sweep", ref: "HIM Sec. 12-5.4, pp. 707-709" },
  { metric: "Pumping and circulation (correlation)", eq: T`Q = N_Q N D^3,\quad t_c = V/Q\quad (N_Q \approx 0.72\ \text{Rushton},\ 0.79\ \text{PBT})`,
    why: "Circulation time sets the drops' passes through the high-dissipation region; needs N_Q per impeller type (or the CFD flow rate below)",
    ref: "HIM eq. (6-3), p. 358, Table 6-3, p. 359" },
  { metric: "Holdup correction for viscous drops", eq: T`(1 + 3\phi)\ \text{on We},\quad (1 - 2.5\phi)\ \text{on Vi in eq. (12-26)}`,
    why: "Extends the viscous-drop correlation to phi < 0.3 (not validated experimentally)", ref: "HIM p. 664" },
  { metric: "Approach to equilibrium drop size",
    eq: T`\frac{d\psi}{d\theta} = -\alpha_1 \psi^{\alpha_2},\ \psi = \frac{d_{32}(t) - d_{32}^\infty}{d_{32}^\infty},\ \theta = Nt;\quad \frac{d_{32}(t)}{d_{32}^\infty} = \left(\frac{3.8\times 10^3}{Nt}\right)^{1/6}\ (100 < Nt < 3800)`,
    why: "Time to equilibrium dispersion (number of impeller turns) from the d32(t) series", ref: "HIM eqs. (12-32), (12-33), pp. 676-677" },
  { metric: "Liquid-liquid mass transfer", eq: T`k_L\,a,\quad a\ \text{from the CFD interface}`,
    why: "Extraction and reaction rates", ref: "HIM Ch. 12, p. 644" },
];

// Fluid-dynamics analyses not in the app yet (data: what the M-Star output already provides)
const FLOW_GAPS: { metric: string; eq: string; why: string; data: string; ref: string }[] = [
  { metric: "Local dissipation distribution",
    eq: T`\varepsilon/\bar\varepsilon\ \text{PDF},\quad \varepsilon_\mathrm{max}/\bar\varepsilon,\quad \text{share of } P \text{ dissipated in the impeller swept volume},\quad \eta/\Delta x\ \text{field}`,
    why: "Replaces the assumed eps_ratio and the eps_max ~ P/(rho D^3) estimate in the Hinze d_max with CFD values; shows where the grid under-resolves",
    data: "Volume: Energy Dissipation Rate", ref: "HIM eq. (2-19), Fig. 2-15, pp. 55-56; pp. 657-658" },
  { metric: "Impeller pumping number and circulation time (CFD)",
    eq: T`Q = \int_S \mathbf u\cdot\mathbf n\,dS,\quad N_Q = \frac{Q}{N D^3},\quad t_c = \frac{V}{Q}`,
    why: "Validates the impeller model against N_Q tables; t_c links blend time and drop passes",
    data: "Volume: Velocity Vector + impeller geometry (input.xml)", ref: "HIM eq. (6-3), p. 358, Table 6-3, p. 359" },
  { metric: "Micromixing time scales",
    eq: T`\tau_E = 17\left(\frac{\nu}{\varepsilon}\right)^{1/2},\quad \lambda_B = \eta\,\mathrm{Sc}^{-1/2},\quad \text{compare with } t_{95} \text{ and reaction times}`,
    why: "Feed location and selectivity of fast competing reactions",
    data: "Volume: Energy Dissipation Rate, Fluid Viscosity (+ diffusivity)", ref: "HIM eq. (13-16), p. 776; Table 2-4, p. 52" },
  { metric: "Shear rate and stress distribution",
    eq: T`\dot\gamma_\mathrm{avg} = k_s N\ \text{(Metzner-Otto) vs the CFD mean strain rate};\quad \text{PDF of } \tau,\ V(\tau > \tau_\mathrm{crit})/V`,
    why: "Shear-sensitive products (cells, crystals, emulsions), non-Newtonian scale-up",
    data: "Fluid.txt: Mean Strain Rate; Volume: Resolved Shear Stress", ref: "HIM eq. (6-17), p. 369, Table 6-5, p. 370" },
  { metric: "Flow pattern and dead zones",
    eq: T`V\left(|\mathbf u| < 0.05\,v_\mathrm{tip}\right)/V,\quad \text{PDF of } |\mathbf u|/v_\mathrm{tip},\quad \text{axial/radial/tangential split}`,
    why: "Poorly mixed regions and flow regime (radial vs axial); partly possible now with cfd_zoner on Velocity Magnitude",
    data: "Volume: Velocity Vector", ref: "HIM Ch. 6 (flow patterns); threshold is an app convention" },
  { metric: "Time-averaged fields and turbulence statistics",
    eq: T`\bar{\mathbf u} = \frac1n\sum_i \mathbf u_i,\quad k = \tfrac12\,\overline{u_i' u_i'},\quad L \sim \frac{k^{3/2}}{\varepsilon}`,
    why: "Snapshots mix the mean flow with turbulence, trailing vortices and macroinstabilities; mean flow and k are what PIV/LDV report",
    data: "Many Volume frames over the steady window (I/O heavy), or M-Star time-averaged output", ref: "HIM Sec. 2-4, pp. 61-77" },
  { metric: "Free-surface shape and vortex depth",
    eq: T`h_\mathrm{vortex} = \max z_\mathrm{surf} - \min z_\mathrm{surf}`,
    why: "Gas entrainment and vibration in unbaffled or narrow-baffle tanks; only for cases with a free surface",
    data: "VOF surface of the gas phase", ref: "HIM p. 380" },
];

export default function TheoryView() {
  return (
    <div className="split theory">
      <div className="side">
        <h3>Theory</h3>
        {SECTIONS.map((s) => <div key={s.id}><a href={`#th-${s.id}`}>{s.title}</a></div>)}
        <div><a href="#th-gaps">Not yet in the app</a></div>
        <div><a href="#th-flowgaps">Fluid dynamics not yet in the app</a></div>
        <div><a href="#th-refs">References</a></div>
      </div>
      <div className="main panel">
        <h2>Theory and equations</h2>
        <p className="muted">Equations computed by the app (mstar_stats_summary.py, cfd_zoner.py, calc_ua.py, the
          backend and the Viewer), with the units written to the outputs. Handbook (HIM) equation and page numbers refer
          to the 2004 edition.</p>
        {SECTIONS.map((s) => (
          <section key={s.id} id={`th-${s.id}`}>
            <h3>{s.title}</h3>
            {s.intro && <p className="small muted">{s.intro}</p>}
            {s.items.map((e) => (
              <div key={e.name} className="card">
                <b>{e.name}</b>
                {e.eq.map((l, i) => <Tex key={i} src={l} />)}
                <table className="vars small"><tbody>{e.vars.map(([s, d]) => (
                  <tr key={s}><td><Tex src={s} block={false} /></td><td>{d}</td></tr>))}</tbody></table>
                {e.note && <div className="small">{e.note}</div>}
                {e.cite && <div className="small cite">{e.cite}</div>}
                <div className="small muted">used in: {e.where}
                  {e.refs && <> | source: {e.refs.map((r) => <a key={r} href={`#ref-${r}`} className="ref">[{r}]</a>)}</>}</div>
              </div>
            ))}
          </section>
        ))}
        <section id="th-gaps">
          <h3>Handbook metrics not yet in the app</h3>
          <table className="grid">
            <thead><tr><th>metric</th><th>equation / criterion</th><th>why</th><th>source</th></tr></thead>
            <tbody>{GAPS.map((g) => (
              <tr key={g.metric}><td>{g.metric}</td><td><Tex src={g.eq} block={false} /></td><td className="small">{g.why}</td>
                <td className="small">{g.ref}</td></tr>))}</tbody>
          </table>
        </section>
        <section id="th-flowgaps">
          <h3>Fluid-dynamics analyses not yet in the app</h3>
          <p className="small muted">Standard stirred-tank flow analyses that the existing M-Star output already supports.</p>
          <table className="grid">
            <thead><tr><th>analysis</th><th>equation / quantity</th><th>why</th><th>data</th><th>source</th></tr></thead>
            <tbody>{FLOW_GAPS.map((g) => (
              <tr key={g.metric}><td>{g.metric}</td><td><Tex src={g.eq} block={false} /></td><td className="small">{g.why}</td>
                <td className="small">{g.data}</td><td className="small">{g.ref}</td></tr>))}</tbody>
          </table>
        </section>
        <section id="th-refs">
          <h3>References</h3>
          <ul className="refs">{Object.entries(REFS).map(([k, v]) => (
            <li key={k} id={`ref-${k}`}><b>[{k}]</b> {v}</li>))}</ul>
          <p className="small muted">HIM page and equation numbers are those of the 2004 Wiley-Interscience edition.</p>
        </section>
      </div>
    </div>
  );
}
